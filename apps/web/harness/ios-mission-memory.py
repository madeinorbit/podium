"""Foreground iPhone Safari capture against an isolated synthetic preview.

Run on the Mac runner with an owned simulator and SafariDriver. Uses only the
Python standard library; never reads operator data or terminates processes.
"""
import argparse
import ctypes
import json
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
parser.add_argument('--openurl', action='store_true', help='Capture normal Safari opened by simctl, without WebDriver')
parser.add_argument('--expect-working', action='store_true')
parser.add_argument('--expect-static', action='store_true')
parser.add_argument('--desktop', action='store_true', help='Capture native desktop Safari instead of an iPhone webview')
args = parser.parse_args()
out = pathlib.Path(args.out)
out.mkdir(parents=True, exist_ok=True)
(out / 'capture.pid').write_text(str(os.getpid()))
start = time.monotonic()
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
        stream.write(json.dumps({'elapsed': round(time.monotonic() - start, 3), **value}) + '\n')


def sample():
    # rusage_info_v2: UUID, then user/system time, two wakeup counts, pageins,
    # wired_size, resident_size, phys_footprint, start/exit time, child metrics.
    global latest_processes
    previous = {}
    while not stop.is_set():
        processes = []
        listing = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,command='], text=True)
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
        append('memory.ndjson', {'processes': processes})
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
    endpoint = urllib.parse.urljoin(args.url, '/__latest')
    deadline = time.monotonic() + 60
    last = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(endpoint, timeout=5) as response:
                last = json.load(response)
            if (last and last.get('url') == args.url and last.get('rows', 0) > 0 and
                    any(count.get('items', 0) >= 80 for count in (last.get('retained') or {}).values()) and
                    (not args.expect_working or last.get('working')) and
                    (not args.expect_static or last.get('markAnimations') == 0)):
                append('page.ndjson', {'preflight': last})
                return
        except (OSError, ValueError):
            pass
        stop.wait(1)
    raise RuntimeError({'preflightFailed': last})


thread = threading.Thread(target=sample, daemon=True)
thread.start()
session = None
try:
    if args.openurl:
        subprocess.run(['xcrun', 'simctl', 'openurl', args.udid, args.url], check=True)
        preflight()
        stop.wait(args.seconds)
        stop.set()
        thread.join(3)
        memory_categories()
        subprocess.run(['xcrun', 'simctl', 'io', args.udid, 'screenshot', str(out / 'phone.png')], check=True,
                       stdout=subprocess.DEVNULL)
    else:
        pass
    if args.openurl:
        # Normal Safari telemetry is written by the isolated preview.
        raise SystemExit(0)
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
    memory_categories()
    import base64
    (out / 'phone.png').write_bytes(base64.b64decode(screenshot))
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
            subprocess.run([*log_prefix, 'log', 'show', '--last', '5m',
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
