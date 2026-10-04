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

parser = argparse.ArgumentParser()
parser.add_argument('--udid', required=True)
parser.add_argument('--url', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--driver', default='http://127.0.0.1:19689')
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--openurl', action='store_true', help='Capture normal Safari opened by simctl, without WebDriver')
args = parser.parse_args()
out = pathlib.Path(args.out)
out.mkdir(parents=True, exist_ok=True)
(out / 'capture.pid').write_text(str(os.getpid()))
start = time.monotonic()
stop = threading.Event()
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')


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
    while not stop.is_set():
        processes = []
        listing = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,command='], text=True)
        for line in listing.splitlines():
            parts = line.strip().split(None, 3)
            if len(parts) != 4:
                continue
            pid, parent, rss, command = parts
            if 'CoreSimulator' not in command or not any(
                    name in command for name in ('WebContent', 'GPU', 'MobileSafari')):
                continue
            usage = ctypes.create_string_buffer(512)
            status = libproc.proc_pid_rusage(int(pid), 2, usage)
            footprint = ctypes.c_uint64.from_buffer(usage, 16 + 7 * 8).value if status == 0 else None
            processes.append({'pid': int(pid), 'ppid': int(parent), 'rssBytes': int(rss) * 1024,
                              'footprintBytes': footprint, 'command': command})
        append('memory.ndjson', {'processes': processes})
        stop.wait(1)


thread = threading.Thread(target=sample, daemon=True)
thread.start()
session = None
try:
    if args.openurl:
        subprocess.run(['xcrun', 'simctl', 'openurl', args.udid, args.url], check=True)
        stop.wait(args.seconds)
        subprocess.run(['xcrun', 'simctl', 'io', args.udid, 'screenshot', str(out / 'phone.png')], check=True,
                       stdout=subprocess.DEVNULL)
    else:
        pass
    if args.openurl:
        # Normal Safari telemetry is written by the isolated preview.
        raise SystemExit(0)
    capabilities = {'browserName': 'Safari', 'platformName': 'iOS',
                    'safari:useSimulator': True, 'safari:deviceUDID': args.udid}
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': capabilities}}, 90)
    session = value['sessionId']
    (out / 'session.json').write_text(json.dumps(value, indent=2))
    base = '/session/' + session
    request('POST', base + '/timeouts', {'pageLoad': 60000, 'script': 15000})
    try:
        request('POST', base + '/url', {'url': args.url}, 75)
    except Exception as error:
        append('page.ndjson', {'navigationError': str(error)})
    end = time.monotonic() + args.seconds
    script = """
      return {url:location.href, age:performance.now(),
        nodes:document.getElementsByTagName('*').length,
        rows:document.querySelectorAll('[data-block]').length,
        scroll:Array.from(document.querySelectorAll('[data-testid="transcript-scroller"]')).map(s=>({top:s.scrollTop,height:s.scrollHeight,viewport:s.clientHeight})),
        marks:document.querySelectorAll('.pod-mark').length,
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
            subprocess.run(['xcrun', 'simctl', 'spawn', args.udid, 'log', 'show', '--last', '5m',
                            '--style', 'compact', '--predicate',
                            'process == "MobileSafari" OR process CONTAINS "WebContent"'],
                           stdout=native, stderr=subprocess.STDOUT, timeout=30)
        except subprocess.TimeoutExpired:
            append('page.ndjson', {'nativeLogError': 'log show timed out'})
    print(json.dumps({'out': str(out), 'elapsed': round(time.monotonic() - start, 1)}), flush=True)
