#!/usr/bin/env python3
"""Foreground, owned-process runner for the isolated working-mark fixture.

Run only under the host's benchmark lease. Dependencies and Chrome binaries
must already be in the issue-owned directory. This owns the loopback server,
driver and private Chrome profile, records their identities, and cleans them
before returning, even when a collector fails. No other process is signalled.
"""
import argparse
import base64
import gzip
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time

spec = importlib.util.spec_from_file_location('mark_bench', Path(__file__).with_name('working-mark-bench.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def save(path, value):
    with gzip.open(path, 'wt') as file:
        json.dump(value, file, separators=(',', ':'))


def process_table():
    lines = subprocess.check_output(['ps', '-axww', '-o', 'pid=,ppid=,command='], text=True, timeout=10).splitlines()
    return {int(pid): {'parent': int(parent), 'command': command}
            for pid, parent, command in (line.strip().split(None, 2) for line in lines if line.strip())}


def stop_owned_chrome(root, fixture, binary, adapter):
    """Close a private Chrome launch even if session creation never replied.

    Mac crash handlers detach and omit the profile argument. An application
    bundle inside THIS fixture directory is also owned; shared binaries never
    establish ownership. Every PID is saved before signalling and rechecked.
    """
    profile = str(root / ('driver/chrome-profile' if adapter else 'chrome-profile'))
    app = next((parent for parent in binary.resolve().parents
                if parent.suffix == '.app' and parent.is_relative_to(fixture.parent)), None)
    table = process_table()
    cohort = {pid for pid, info in table.items() if '--user-data-dir=' + profile in info['command'].split() or
              '--database=' + profile + '/Crashpad' in info['command'].split() or
              (app is not None and info['command'].startswith(str(app) + '/'))}
    while True:
        children = {pid for pid, info in table.items() if info['parent'] in cohort}
        if children <= cohort:
            break
        cohort |= children
    evidence = {'startedAt': time.time(), 'profile': profile, 'privateApp': str(app) if app else None,
                'recordedProcesses': {pid: table[pid] for pid in cohort}, 'signals': []}
    path = root / 'browser-process-cleanup.json.gz'
    save(path, evidence)
    if cohort:
        current = process_table()
        for pid in sorted(cohort):
            if current.get(pid, {}).get('command') == table[pid]['command']:
                try:
                    os.kill(pid, signal.SIGTERM)
                    evidence['signals'].append({'pid': pid, 'signal': 'TERM'})
                except ProcessLookupError:
                    pass
        time.sleep(2)
        current = process_table()
        for pid in sorted(cohort):
            if current.get(pid, {}).get('command') == table[pid]['command']:
                try:
                    os.kill(pid, signal.SIGKILL)
                    evidence['signals'].append({'pid': pid, 'signal': 'KILL'})
                except ProcessLookupError:
                    pass
        save(path, evidence)
        time.sleep(.2)
        current = process_table()
        evidence['remainingRecordedPids'] = [pid for pid in cohort
                                            if current.get(pid, {}).get('command') == table[pid]['command']]
    else:
        evidence['remainingRecordedPids'] = []
    evidence['endedAt'] = time.time()
    save(path, evidence)
    return {'recordedPids': sorted(cohort), 'remainingRecordedPids': evidence['remainingRecordedPids']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['chrome-adapter', 'chrome', 'safari'], required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--browser-binary', type=Path)
    parser.add_argument('--driver-binary', type=Path)
    parser.add_argument('--bun', type=Path)
    parser.add_argument('--preview-port', type=int, default=19657)
    parser.add_argument('--driver-port', type=int, default=19658)
    parser.add_argument('--headed', action='store_true')
    parser.add_argument('--lane', choices=['preflight', 'visible', 'chrome-extras', 'visibility'], required=True)
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--idle-seconds', type=float, default=20)
    parser.add_argument('--viewport', default='800x600')
    parser.add_argument('--max-load', type=float, help='Refuse a timing lane when initial one-minute load exceeds this bound')
    parser.add_argument('--candidates', help='Comma-separated candidates for the visible lane, e.g. static,tetra.dots,tetra.flip')
    parser.add_argument('--count', type=int, default=32, help='Marks in the fixture for the visible lane')
    parser.add_argument('--allow-unfocused', action='store_true', help='Pass through: measure with a visible but unfocused window, recording the state')
    parser.add_argument('--mode', choices=['visible', 'offscreen', 'hidden'], default='visible',
                        help='Pass through for the visible lane: marks on screen, off screen in skipped content-visibility rows, or under display:none')
    parser.add_argument('--skip-typing', action='store_true', help='Pass through: idle window only')
    args = parser.parse_args()
    root = args.root.resolve()
    fixture = args.fixture.resolve(strict=True)
    root.mkdir(parents=True, exist_ok=True)
    record = {'startedAt': time.time(), 'runnerPid': os.getpid(), 'engine': args.engine,
              'lane': args.lane, 'loadAtStart': os.getloadavg(), 'fixture': str(fixture),
              'recordedPids': [], 'collectors': []}
    save(root / 'session.json.gz', record)
    if args.lane != 'preflight' and args.max_load is not None and os.getloadavg()[0] > args.max_load:
        record['error'] = 'Host load exceeds the requested quiet-window bound; no browser started'
        record['endedAt'] = time.time()
        save(root / 'session.json.gz', record)
        raise RuntimeError('Host load exceeds the requested quiet-window bound; no browser started')
    # Never mistake an existing driver's /status for our just-created process.
    with socket.socket() as available:
        available.bind(('127.0.0.1', args.driver_port))

    class FixtureHandler(SimpleHTTPRequestHandler):
        def __init__(self, *values, **options):
            super().__init__(*values, directory=str(fixture.parent), **options)

        def log_message(self, *_):
            pass

        def send_head(self):
            # Safari plays a video only from a server that answers byte-range requests.
            path, wanted = self.translate_path(self.path), self.headers.get('Range', '')
            parts = wanted.strip().removeprefix('bytes=').split('-')
            if not wanted.startswith('bytes=') or len(parts) != 2 or not os.path.isfile(path) or not any(parts):
                return super().send_head()
            size = os.path.getsize(path)
            start = int(parts[0]) if parts[0] else max(0, size - int(parts[1]))
            end = min(size - 1, int(parts[1])) if parts[0] and parts[1] else size - 1
            if start > end:
                self.send_error(416)
                return None
            with open(path, 'rb') as file:
                file.seek(start)
                body = file.read(end - start + 1)
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            return io.BytesIO(body)

    server = ThreadingHTTPServer(('127.0.0.1', args.preview_port), FixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    driver_base = f'http://127.0.0.1:{args.driver_port}'
    url = f'http://127.0.0.1:{args.preview_port}/{fixture.name}'
    driver = None
    session = None
    log_thread = None
    before = {}
    safari_owner = None
    try:
        before = process_table()
        if args.engine == 'chrome-adapter':
            if not args.bun or not args.browser_binary:
                raise RuntimeError('The adapter requires private --bun and --browser-binary paths')
            command = [str(args.bun), str(Path(__file__).with_name('working-mark-chrome-driver.mjs')),
                       '--root', str(root / 'driver'), '--chrome', str(args.browser_binary),
                       '--port', str(args.driver_port)]
            if args.headed:
                command.append('--headed')
        else:
            if not args.driver_binary:
                raise RuntimeError('The real browser requires --driver-binary')
            command = [str(args.driver_binary), '-p', str(args.driver_port)] if args.engine == 'safari' else [str(args.driver_binary), '--port=' + str(args.driver_port)]
        driver = subprocess.Popen(command, cwd=fixture.parent, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        record['recordedPids'].append({'pid': driver.pid, 'role': 'driver', 'command': command, 'cwd': str(fixture.parent)})
        save(root / 'session.json.gz', record)

        def compress_log():
            with gzip.open(root / 'driver.log.gz', 'wb') as file:
                while chunk := driver.stdout.read(4096):
                    file.write(chunk)

        log_thread = threading.Thread(target=compress_log, daemon=True)
        log_thread.start()
        deadline = time.monotonic() + 30
        while True:
            if driver.poll() is not None:
                raise RuntimeError(f'Owned driver exited {driver.returncode}')
            try:
                status = bench.request(driver_base, 'GET', '/status', timeout=2)
                if status.get('ready'):
                    record['driverStatus'] = status
                    break
            except (OSError, RuntimeError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('Owned driver did not become ready within 30 seconds')
            time.sleep(.2)
        if args.engine == 'chrome-adapter':
            session = status['sessionId']
        else:
            capabilities = {'browserName': 'safari' if args.engine == 'safari' else 'chrome'}
            if args.engine == 'chrome':
                if not args.browser_binary:
                    raise RuntimeError('Chrome requires its private --browser-binary')
                chrome_args = ['--user-data-dir=' + str(root / 'chrome-profile'), '--no-first-run', '--no-default-browser-check']
                if not args.headed:
                    chrome_args.append('--headless=new')
                capabilities['goog:chromeOptions'] = {'binary': str(args.browser_binary), 'args': chrome_args}
            created = bench.request(driver_base, 'POST', '/session', {'capabilities': {'alwaysMatch': capabilities}}, timeout=30)
            session = created['sessionId']
            record['capabilities'] = created['capabilities']
        base = driver_base + '/session/' + session
        record['sessionId'] = session
        save(root / 'session.json.gz', record)
        if args.engine == 'chrome' and args.headed and sys.platform == 'darwin':
            browser_pid = int(record['capabilities']['goog:processID'])
            browser_command = process_table().get(browser_pid, {}).get('command', '')
            if not browser_command.startswith(str(args.browser_binary) + ' '):
                raise RuntimeError('Chrome activation requires the recorded private browser executable')
            record['recordedPids'].append({'pid': browser_pid, 'role': 'chrome-application', 'command': browser_command})
            save(root / 'session.json.gz', record)
            script = 'ObjC.import("AppKit"); Boolean($.NSRunningApplication.runningApplicationWithProcessIdentifier(' + str(browser_pid) + ').activateWithOptions(2));'
            record['nativeActivation'] = subprocess.check_output(['osascript', '-l', 'JavaScript', '-e', script], text=True, timeout=10).strip()
            save(root / 'session.json.gz', record)
            time.sleep(.5)
        bench.request(base, 'POST', '/url', {'url': url + '?bench=1&candidate=static&count=32'}, timeout=30)
        time.sleep(2)
        after = process_table()
        record['newBrowserProcesses'] = {pid: info for pid, info in after.items() if pid not in before and ('WebKit' in info['command'] or 'Safari' in info['command'] or 'chrome' in info['command'].lower())}
        save(root / 'session.json.gz', record)
        if args.engine == 'chrome-adapter':
            processes = bench.request(base, 'GET', '/processes')
            pids = [process['id'] for process in processes if process['type'] == 'renderer']
        elif args.engine == 'chrome':
            cohort = {pid for pid, info in after.items() if '--user-data-dir=' + str(root / 'chrome-profile') in info['command']}
            while True:
                children = {pid for pid, info in after.items() if info['parent'] in cohort}
                if children <= cohort:
                    break
                cohort |= children
            pids = [pid for pid in cohort if '--type=renderer' in after[pid]['command']]
        else:
            owners = [pid for pid, info in after.items() if pid not in before and
                      info['command'].split(None, 1)[0].endswith('/Safari.app/Contents/MacOS/Safari') and
                      '--automation' in info['command'].split()]
            preexisting = False
            if not owners:
                # safaridriver drives an already running Safari instead of launching an automation copy.
                # Measure that one, but never signal it: we did not start it.
                owners = [pid for pid, info in after.items() if pid in before and
                          info['command'].split(None, 1)[0].endswith('/Safari.app/Contents/MacOS/Safari')]
                preexisting = True
            if len(owners) != 1:
                raise RuntimeError(f'Expected one Safari application; got {owners}, refusing ambiguous ownership')
            safari_owner = {'pid': owners[0], 'command': after[owners[0]]['command'], 'preexisting': preexisting}
            record['safariAutomationOwner'] = safari_owner
            if not preexisting:
                record['recordedPids'].append({'pid': owners[0], 'role': 'safari-automation-application', 'command': safari_owner['command']})
            save(root / 'session.json.gz', record)
            # The typing probe needs a focused page. A system alert can sit in front of everything on this
            # runner, and activating from a background process is refused; LaunchServices (`open`) is not.
            subprocess.run(['open', '-a', 'Safari'], check=True, timeout=20)
            time.sleep(.5)
            record['safariWebContentCohort'] = bench.safari_webcontent(owners[0])
            pids = sorted(record['safariWebContentCohort']['processes'])
        if not pids:
            raise RuntimeError('No owned renderer process was established')
        record['renderers'] = {pid: after[pid] for pid in pids}
        record['processesBefore'] = {pid: info for pid, info in before.items() if 'WebKit' in info['command'] or 'Safari' in info['command']}
        record['environment'] = bench.request(base, 'POST', '/execute/sync', {'script': bench.ENVIRONMENT, 'args': []})
        save(root / 'session.json.gz', record)

        def run_collector(command, name):
            child = subprocess.Popen(command, cwd=fixture.parent)
            record['recordedPids'].append({'pid': child.pid, 'role': 'collector', 'command': command, 'cwd': str(fixture.parent)})
            save(root / 'session.json.gz', record)
            try:
                status = child.wait()
                if status:
                    raise subprocess.CalledProcessError(status, command)
                record['collectors'].append({'name': name, 'exitCode': status})
                save(root / 'session.json.gz', record)
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)

        def collect(name, extra):
            command = [sys.executable, str(Path(__file__).with_name('working-mark-bench.py')),
                       '--driver', driver_base, '--session', session, '--url', url,
                       '--sha', args.sha, '--asset-manifest', str(args.assets), '--source-file', str(fixture),
                       '--out', str(root / name), '--viewport', args.viewport]
            for pid in pids:
                command += ['--pid', str(pid)]
            if safari_owner is not None:
                command += ['--safari-owner-pid', str(safari_owner['pid']), '--expect-motion', 'no-preference']
            elif args.engine == 'chrome':
                command += ['--chrome-profile', str(root / 'chrome-profile'), '--expect-motion', 'no-preference']
                app = next((parent for parent in args.browser_binary.resolve().parents if parent.suffix == '.app'), None)
                if app is not None:
                    command += ['--chrome-app', str(app)]
            command += extra
            run_collector(command, name)

        def visibility(reduced=False):
            command = [sys.executable, str(Path(__file__).with_name('working-mark-visibility.py')),
                       '--driver', driver_base, '--session', session, '--url', url,
                       '--sha', args.sha, '--out', str(root / ('media-reduce-proof' if reduced else 'return-proof'))]
            if reduced:
                command.append('--reduced')
            run_collector(command, 'media-reduce-proof' if reduced else 'return-proof')

        if args.lane == 'preflight':
            pixels = base64.b64decode(bench.request(base, 'GET', '/screenshot'))
            (root / 'preflight.png').write_bytes(pixels)
        elif args.lane == 'visible':
            extra = ['--candidates', args.candidates] if args.candidates else []
            if args.allow_unfocused:
                extra.append('--allow-unfocused')
            if args.skip_typing:
                extra.append('--skip-typing')
            extra += ['--mode', args.mode]
            collect('visible', ['--repeat', str(args.repeat), '--idle-seconds', str(args.idle_seconds), '--count', str(args.count), '--capture'] + extra)
        elif args.lane == 'visibility':
            visibility()
        else:
            if args.engine != 'chrome-adapter':
                raise RuntimeError('Actual media emulation is only supported by the owned Chrome adapter')
            shared = ['--repeat', '1', '--idle-seconds', '10', '--skip-typing', '--candidates', 'static,breathe,signal,apng,webp']
            collect('hidden', shared + ['--mode', 'hidden', '--expect-motion', 'no-preference'])
            if bench.request(base, 'POST', '/motion', {'value': 'reduce'}) is not True:
                raise RuntimeError('Actual reduced-motion media match was not obtained')
            collect('media-reduce', shared + ['--expect-motion', 'reduce'])
            visibility(reduced=True)
        record['completed'] = True
    except BaseException as error:
        record['error'] = repr(error)
        raise
    finally:
        cleanup = {'startedAt': time.time()}
        if session:
            try:
                bench.request(driver_base + '/session/' + session, 'DELETE', '', timeout=10)
                cleanup['sessionClosed'] = True
            except Exception as error:
                cleanup['sessionCloseError'] = str(error)
        if driver:
            try:
                driver.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # This Popen is the exact process recorded above, never a PID lookup.
                driver.terminate()
                try:
                    driver.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    driver.kill()
                    driver.wait(timeout=5)
            cleanup['recordedDriverPid'] = driver.pid
            cleanup['driverExitCode'] = driver.returncode
        if args.engine != 'safari' and args.browser_binary:
            try:
                cleanup['browserProcesses'] = stop_owned_chrome(root, fixture, args.browser_binary, args.engine == 'chrome-adapter')
                if cleanup['browserProcesses']['remainingRecordedPids']:
                    record['cleanupUnverified'] = True
            except Exception as error:
                cleanup['browserProcessError'] = str(error)
                record['cleanupUnverified'] = True
        if safari_owner is not None and safari_owner.get('preexisting'):
            cleanup['safariAutomationApplication'] = {'recordedPid': safari_owner['pid'], 'preexisting': True, 'signals': []}
        elif safari_owner is not None:
            pid = safari_owner['pid']
            stopped = {'recordedPid': pid, 'recordedCommand': safari_owner['command'], 'signals': []}
            save(root / 'safari-application-cleanup.json.gz', stopped)
            try:
                if process_table().get(pid, {}).get('command') == safari_owner['command']:
                    os.kill(pid, signal.SIGTERM)
                    stopped['signals'].append('TERM')
                    time.sleep(2)
                if process_table().get(pid, {}).get('command') == safari_owner['command']:
                    os.kill(pid, signal.SIGKILL)
                    stopped['signals'].append('KILL')
                    time.sleep(.2)
                stopped['remainingRecordedPids'] = [pid] if process_table().get(pid, {}).get('command') == safari_owner['command'] else []
                if stopped['remainingRecordedPids']:
                    record['cleanupUnverified'] = True
            except Exception as error:
                stopped['error'] = str(error)
                record['cleanupUnverified'] = True
            cleanup['safariAutomationApplication'] = stopped
            save(root / 'safari-application-cleanup.json.gz', stopped)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)
        if log_thread:
            log_thread.join(timeout=5)
        cleanup['endedAt'] = time.time()
        save(root / 'cleanup.json.gz', cleanup)
        if record.get('cleanupUnverified'):
            record['completed'] = False
            record['error'] = 'Owned browser cleanup could not be verified; keep the benchmark lease'
        record['endedAt'] = time.time()
        save(root / 'session.json.gz', record)
        print(json.dumps({'completed': record.get('completed', False), 'error': record.get('error'), 'cleanup': cleanup}), flush=True)
        if record.get('cleanupUnverified'):
            raise RuntimeError(record['error'])


if __name__ == '__main__':
    def stop_owned_run(*_):
        raise KeyboardInterrupt('Owned runner interrupted; closing its session')
    for signal_name in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signal_name, stop_owned_run)
    main()
