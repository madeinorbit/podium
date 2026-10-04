"""Foreground iPhone Safari capture against an isolated synthetic preview.

Run on the Mac runner with an owned simulator and SafariDriver. Uses only the
Python standard library; never reads operator data or terminates processes.
"""
import argparse
import ctypes
import datetime
import json
import math
import os
import pathlib
import subprocess
import threading
import time
import urllib.error
import urllib.request
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--udid', required=True)
parser.add_argument('--url', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--driver', default='http://127.0.0.1:19689')
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--ready-seconds', type=int, default=180)
parser.add_argument('--openurl', action='store_true', help='Capture normal Safari opened by simctl, without WebDriver')
parser.add_argument('--existing', action='store_true', help='Capture the existing normal Safari tab after preview navigation')
parser.add_argument('--expect-working', action='store_true')
parser.add_argument('--expect-static', action='store_true')
parser.add_argument('--desktop', action='store_true', help='Capture native desktop Safari instead of an iPhone webview')
args = parser.parse_args()
out = pathlib.Path(args.out)
out.mkdir(parents=True, exist_ok=True)
(out / 'capture.pid').write_text(str(os.getpid()))
start = time.monotonic()
started_wall = time.time()
observation_ended_wall = None
stop = threading.Event()
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
libsystem = ctypes.CDLL('/usr/lib/libSystem.B.dylib')


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


timebase = Timebase()
libsystem.mach_timebase_info(ctypes.byref(timebase))
cpu_time_to_ns = timebase.numer / timebase.denom
latest_processes = []


def request(method, path, value=None, timeout=30):
    data = None if value is None else json.dumps(value).encode()
    req = urllib.request.Request(args.driver + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    if isinstance(result.get('value'), dict) and 'error' in result['value']:
        raise RuntimeError(result['value'])
    return result['value']


def append(name, value):
    with (out / name).open('a') as stream:
        stream.write(json.dumps({'elapsed': round(time.monotonic() - start, 3),
                                 'time': round(time.time() * 1000), **value}) + '\n')


def sample():
    # rusage_info_v2: UUID, then user/system time, two wakeup counts, pageins,
    # wired_size, resident_size, phys_footprint, start/exit time, child metrics.
    global latest_processes
    previous = {}
    while not stop.is_set():
        processes = []
        try:
            listing = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,command='], text=True, timeout=5)
        except subprocess.TimeoutExpired:
            append('memory.ndjson', {'sampleError': 'ps timed out', 'processes': []})
            stop.wait(1)
            continue
        for line in listing.splitlines():
            parts = line.strip().split(None, 3)
            if len(parts) != 4:
                continue
            pid, parent, rss, command = parts
            simulator = 'CoreSimulator' in command
            if simulator == args.desktop or not any(
                    name in command for name in ('WebContent', 'WebKit.GPU', 'MobileSafari', 'Safari.app/Contents/MacOS/Safari')):
                continue
            usage = ctypes.create_string_buffer(512)
            status = libproc.proc_pid_rusage(int(pid), 2, usage)
            footprint = ctypes.c_uint64.from_buffer(usage, 16 + 7 * 8).value if status == 0 else None
            # XNU supplies Mach absolute CPU time, including exited threads.
            # Convert using this host's timebase; ps %cpu is a lifetime average.
            cpu_ns = sum(ctypes.c_uint64.from_buffer(usage, offset).value
                         for offset in (16, 24)) * cpu_time_to_ns if status == 0 else None
            observed_ns = time.monotonic_ns()
            before = previous.get(int(pid))
            cpu_percent = (100 * (cpu_ns - before[1]) / (observed_ns - before[0])
                           if cpu_ns is not None and before is not None else None)
            if cpu_ns is not None:
                previous[int(pid)] = (observed_ns, cpu_ns)
            processes.append({'pid': int(pid), 'ppid': int(parent), 'rssBytes': int(rss) * 1024,
                              'footprintBytes': footprint, 'cpuNs': cpu_ns,
                              'cpuPercent': cpu_percent, 'command': command})
        latest_processes = processes
        append('memory.ndjson', {'time': round(time.time() * 1000), 'processes': processes})
        stop.wait(1)


def memory_categories():
    # Capture at the end so vmmap does not contaminate the CPU timing interval.
    # Simulator WebContent regions identify JS/JIT/native allocations; these
    # are resident backing stores, not a GC snapshot's live-object byte count.
    for process in latest_processes:
        if 'WebContent' not in process['command']:
            continue
        with (out / f"vmmap-{process['pid']}.txt").open('w') as report:
            try:
                subprocess.run(['vmmap', '-summary', str(process['pid'])], stdout=report,
                               stderr=subprocess.STDOUT, timeout=15)
            except subprocess.TimeoutExpired:
                append('page.ndjson', {'vmmapTimeout': process['pid']})


def preflight():
    if not args.expect_working and not args.expect_static:
        return
    endpoint = urllib.parse.urljoin(args.url, '/__status')
    deadline = time.monotonic() + args.ready_seconds
    last = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(endpoint, timeout=5) as response:
                status = json.load(response)
                last = status.get('page')
            seed = status.get('seedItems', 0)
            seed_received = not seed or (status.get('seedDelivered') and last and any(
                count.get('maximumInput', 0) >= seed and
                (not last.get('retainAll') or count.get('items', 0) >= seed)
                for count in (last.get('retained') or {}).values()))
            if (status.get('subscribers') == 1 and seed_received and last and last.get('url') == args.url and last.get('rows', 0) > 0 and
                    any(count.get('items', 0) >= 80 for count in (last.get('retained') or {}).values()) and
                    (not args.expect_working or last.get('working')) and
                    (not args.expect_static or last.get('markAnimations') == 0)):
                append('page.ndjson', {'preflight': last, 'fixture': status})
                return
        except (OSError, ValueError):
            pass
        stop.wait(1)
    append('page.ndjson', {'preflightFailed': last})
    raise RuntimeError('Synthetic Working chat did not pass native preflight')


def coverage_report(page_records, memory_records, seconds, expect_working=False, expect_static=False):
    """Qualify observed coverage, while preserving failed/crashed traces too."""
    reasons = []
    beginning = next((row['elapsed'] for row in page_records if row.get('preflight')), None)
    if beginning is None:
        beginning = next((row['elapsed'] for row in page_records if row.get('page')), 0)
        if expect_working or expect_static:
            reasons.append('Working/static preflight missing')
    seen = set()
    pages = []
    native = []
    for row in page_records:
        page = row.get('page') or row.get('preflight')
        elapsed = row['elapsed'] - beginning
        if page and page.get('rows', 0) > 0 and 0 <= elapsed <= seconds + 5:
            key = (page.get('boot'), page.get('age'))
            if key not in seen:
                seen.add(key)
                pages.append((elapsed, page, row))
    for row in memory_records:
        elapsed = row['elapsed'] - beginning
        if 0 <= elapsed <= seconds + 5 and any(
                'WebContent' in process['command'] and process.get('footprintBytes') is not None
                for process in row.get('processes', [])):
            native.append(elapsed)

    def series(name, points, minimum):
        span = points[-1] - points[0] if len(points) > 1 else 0
        boundaries = [0, *points, max(seconds, points[-1] if points else seconds)]
        gap = max(b - a for a, b in zip(boundaries, boundaries[1:]))
        if len(points) < minimum or span < seconds * .8 or gap > max(10, seconds * .1):
            reasons.append(f'{name} coverage insufficient')
        return {'samples': len(points), 'spanSeconds': round(span, 3),
                'maximumGapSeconds': round(gap, 3)}

    page_coverage = series('page', [elapsed for elapsed, _, _ in pages], max(2, math.ceil(seconds / 6)))
    native_coverage = series('native', native, max(2, math.ceil(seconds / 3)))
    boots = sorted({page['boot'] for _, page, _ in pages if page.get('boot')})
    if len(boots) > 1:
        reasons.append('document restarted; inspect termination evidence')
    if expect_working and any(not page.get('working') or row.get('subscribers', 1) != 1
                              for _, page, row in pages):
        reasons.append('Working/subscription state changed')
    if expect_static and any(page.get('markAnimations') != 0 for _, page, _ in pages):
        reasons.append('mark animation state changed')
    if expect_working and len(pages) > 1:
        updates = [max((count.get('updates', 0) for count in (page.get('retained') or {}).values()), default=0)
                   for _, page, _ in pages]
        if updates[-1] <= updates[0]:
            reasons.append('no observed controller streaming updates')
        items = [row['serverItems'] for _, _, row in pages if 'serverItems' in row]
        if items and items[-1] <= items[0]:
            reasons.append('no observed server appends')
        late = [(page, row) for elapsed, page, row in pages if elapsed >= seconds * .75]
        late_updates = [max((count.get('updates', 0) for count in (page.get('retained') or {}).values()), default=0)
                        for page, _ in late]
        if len(late_updates) < 2 or late_updates[-1] <= late_updates[0]:
            reasons.append('controller streaming not observed near capture end')
        late_items = [row['serverItems'] for _, row in late if 'serverItems' in row]
        if late_items and late_items[-1] <= late_items[0]:
            reasons.append('server appends stopped before capture end')
    return {'qualified': not reasons, 'requestedSeconds': seconds, 'page': page_coverage,
            'native': native_coverage, 'documentIds': boots, 'reasons': reasons}


def qualify_capture():
    global observation_ended_wall
    observation_ended_wall = time.time()
    def records(name):
        path = out / name
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []
    report = coverage_report(records('page.ndjson'), records('memory.ndjson'), args.seconds,
                             args.expect_working, args.expect_static)
    (out / 'coverage.json').write_text(json.dumps(report, indent=2) + '\n')
    append('page.ndjson', {'coverage': report})
    return report['qualified']


def observe_normal():
    endpoint = urllib.parse.urljoin(args.url, '/__status')
    end = time.monotonic() + args.seconds
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(endpoint, timeout=5) as response:
                status = json.load(response)
            append('page.ndjson', {'page': status.get('page'),
                                  'subscribers': status.get('subscribers'),
                                  'serverItems': status.get('items')})
        except (OSError, ValueError) as error:
            append('page.ndjson', {'telemetryError': str(error)})
        stop.wait(2)


thread = threading.Thread(target=sample, daemon=True)
thread.start()
session = None
try:
    if args.openurl or args.existing:
        if args.openurl:
            subprocess.run(['xcrun', 'simctl', 'openurl', args.udid, args.url], check=True, timeout=30)
        preflight()
        observe_normal()
        stop.set()
        thread.join(3)
        qualified = qualify_capture()
        memory_categories()
        try:
            subprocess.run(['xcrun', 'simctl', 'io', args.udid, 'screenshot', str(out / 'phone.png')], check=True,
                           stdout=subprocess.DEVNULL, timeout=30)
        except subprocess.TimeoutExpired:
            append('page.ndjson', {'screenshotError': 'simctl screenshot timed out'})
    else:
        pass
    if args.openurl or args.existing:
        # Normal Safari telemetry is written by the isolated preview.
        raise SystemExit(0 if qualified else 2)
    capabilities = {'browserName': 'Safari', 'platformName': 'iOS',
                    'safari:useSimulator': True, 'safari:deviceUDID': args.udid}
    if args.desktop:
        capabilities = {'browserName': 'Safari'}
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': capabilities}}, 90)
    session = value['sessionId']
    (out / 'session.json').write_text(json.dumps(value, indent=2))
    base = '/session/' + session
    request('POST', base + '/timeouts', {'pageLoad': 60000, 'script': 15000})
    try:
        request('POST', base + '/url', {'url': args.url}, 75)
    except Exception as error:
        append('page.ndjson', {'navigationError': str(error)})
    preflight()
    end = time.monotonic() + args.seconds
    script = """
      return {url:location.href, age:performance.now(),
        nodes:document.getElementsByTagName('*').length,
        rows:document.querySelectorAll('[data-block]').length,
        scroll:Array.from(document.querySelectorAll('[data-testid="transcript-scroller"]')).map(s=>({top:s.scrollTop,height:s.scrollHeight,viewport:s.clientHeight})),
        marks:document.querySelectorAll('.pod-mark').length,
        retained:window.__fixtureTranscriptCounts || null,
        worker:window.__fixtureWorkerCounts || null,
        canvases:Array.from(document.querySelectorAll('canvas')).map(c=>[c.width,c.height]),
        images:document.images.length, errors:window.__fixtureErrors || [],
        text:document.body.innerText.slice(-700)};
    """
    if args.desktop:
        observe_normal()
    else:
        while time.monotonic() < end:
            try:
                append('page.ndjson', {'page': request('POST', base + '/execute/sync',
                                                      {'script': script, 'args': []}, 20)})
            except Exception as error:
                append('page.ndjson', {'error': str(error)})
            stop.wait(2)
    screenshot = request('GET', base + '/screenshot', timeout=20)
    stop.set()
    thread.join(3)
    qualified = qualify_capture()
    memory_categories()
    import base64
    (out / 'phone.png').write_bytes(base64.b64decode(screenshot))
    if not qualified:
        raise RuntimeError('Native measurement coverage insufficient; see coverage.json')
except Exception as error:
    append('page.ndjson', {'error': str(error)})
    raise
finally:
    stop.set()
    thread.join(3)
    if session:
        try:
            request('DELETE', '/session/' + session, timeout=15)
        except Exception as error:
            append('page.ndjson', {'cleanupError': str(error)})
    with (out / 'native.log').open('w') as native:
        try:
            log_prefix = [] if args.desktop else ['xcrun', 'simctl', 'spawn', args.udid]
            # Anchor to the actual interval: slow vmmap/screenshot commands must
            # not move a relative five-minute log window past the useful trace.
            log_time = lambda value: datetime.datetime.fromtimestamp(value).astimezone().strftime('%Y-%m-%d %H:%M:%S%z')
            subprocess.run([*log_prefix, 'log', 'show', '--start', log_time(started_wall),
                            '--end', log_time(observation_ended_wall or time.time()),
                            '--style', 'compact', '--predicate',
                            'eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "memorystatus" OR '
                            '((process == "MobileSafari" OR process CONTAINS "WebContent" OR process == "runningboardd") AND '
                            '(eventMessage CONTAINS[c] "exit" OR eventMessage CONTAINS[c] "crash" OR '
                            'eventMessage CONTAINS[c] "terminated" OR eventMessage CONTAINS[c] "termination" OR '
                            'eventMessage CONTAINS[c] "memory pressure" OR eventMessage CONTAINS[c] "memory limit"))'],
                           stdout=native, stderr=subprocess.STDOUT, timeout=30)
        except subprocess.TimeoutExpired:
            append('page.ndjson', {'nativeLogError': 'log show timed out'})
    print(json.dumps({'out': str(out), 'elapsed': round(time.monotonic() - start, 1)}), flush=True)
