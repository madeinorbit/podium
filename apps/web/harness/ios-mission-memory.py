"""Foreground iPhone Safari capture against an isolated synthetic preview.

Run on the Mac runner with an owned simulator and SafariDriver. Uses only the
Python standard library; never reads operator data or terminates processes.
"""
import argparse
import ctypes
import json
import pathlib
import subprocess
import threading
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--udid', required=True)
parser.add_argument('--url', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--driver', default='http://127.0.0.1:19689')
parser.add_argument('--seconds', type=int, default=60)
args = parser.parse_args()
out = pathlib.Path(args.out)
out.mkdir(parents=True, exist_ok=True)
start = time.monotonic()
stop = threading.Event()
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')


def request(method, path, value=None, timeout=30):
    data = None if value is None else json.dumps(value).encode()
    req = urllib.request.Request(args.driver + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        result = json.load(response)
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
    capabilities = {'browserName': 'Safari', 'platformName': 'iOS',
                    'safari:useSimulator': True, 'safari:deviceUDID': args.udid}
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': capabilities}}, 90)
    session = value['sessionId']
    (out / 'session.json').write_text(json.dumps(value, indent=2))
    base = '/session/' + session
    request('POST', base + '/timeouts', {'pageLoad': 60000, 'script': 15000})
    request('POST', base + '/url', {'url': args.url}, 75)
    end = time.monotonic() + args.seconds
    script = """
      return {url:location.href, age:performance.now(),
        nodes:document.getElementsByTagName('*').length,
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
    print(json.dumps({'out': str(out), 'elapsed': round(time.monotonic() - start, 1)}), flush=True)
