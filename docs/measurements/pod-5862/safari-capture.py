#!/usr/bin/env python3
"""Counter-only Safari capture. Requires bench:podium-apple-runner lease.

The credential arrives on stdin and is never saved. WebContent ownership uses
macOS responsibility, as in POD-5558; footprint includes compressed memory.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error


def request(base, method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            value = json.load(response).get('value')
    except urllib.error.HTTPError as error:
        raise RuntimeError('WebDriver HTTP ' + str(error.code)) from None
    if isinstance(value, dict) and value.get('error'):
        raise RuntimeError('WebDriver ' + value['error'])
    return value


def processes():
    lines = subprocess.check_output(['ps', '-axww', '-o', 'pid=,rss=,command='], text=True).splitlines()
    return {int(pid): {'rssKiB': int(rss), 'command': command}
            for pid, rss, command in (line.strip().split(None, 2) for line in lines if line.strip())}


responsible = ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid
responsible.argtypes = [ctypes.c_int]
responsible.restype = ctypes.c_int
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')

class Timebase(ctypes.Structure):
    _fields_ = [('numer',ctypes.c_uint32),('denom',ctypes.c_uint32)]

timebase = Timebase()
ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(ctypes.byref(timebase))


def footprint(pid):
    usage = ctypes.create_string_buffer(512)
    if libproc.proc_pid_rusage(pid, 4, usage) != 0:
        return None
    return ctypes.c_uint64.from_buffer(usage, 72).value


def cpu_time(pid):
    usage = ctypes.create_string_buffer(512)
    if libproc.proc_pid_rusage(pid, 4, usage) != 0: return None
    return sum(ctypes.c_uint64.from_buffer(usage, offset).value for offset in (16,24))*timebase.numer/timebase.denom


FIND_POOL = """
const element = document.getElementById('root');
const key = element && Object.keys(element).find(k => k.startsWith('__reactContainer$'));
if (!key) return false;
const start = element[key];
const fibers = [start.stateNode?.current ?? start], seen = new Set();
while (fibers.length) {
  const f = fibers.pop(); if (!f || seen.has(f)) continue; seen.add(f);
  if (f.child) fibers.push(f.child); if (f.sibling) fibers.push(f.sibling);
  const objects = [{v:f.memoizedProps,d:0},{v:f.memoizedState,d:0}], checked = new Set();
  while (objects.length) {
    const {v,d} = objects.pop();
    if (!v || typeof v !== 'object' || checked.has(v) || d > 4) continue;
    checked.add(v);
    if (v.tables && v.graph && v.queries) { window.__memoryPool = new WeakRef(v); return true; }
    for (const [k,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (k === 'next' && d === 0) objects.push({v:descriptor.value,d});
      else if (['pool','host','view','row','model','issue','session','worklist','memoizedState','value','current','deck','0','1','2','3'].includes(k)) objects.push({v:descriptor.value,d:d+1});
    }
  }
}
return false;
"""

COUNTERS = """
const pool = window.__memoryPool?.deref(), counts = {}, seen = new Set();
function walk(v,path,depth) {
  if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return;
  seen.add(v);
  if (typeof v.size === 'number') { counts[path] = v.size; return; }
  if (Array.isArray(v)) { counts[path] = v.length; return; }
  for (const [k,d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (d.value && typeof d.value === 'object') walk(d.value,path+'.'+k,depth+1);
  }
}
if (pool) {
  walk(pool,'pool',0);
  for (const [key,value] of pool.sources.views) walk(value,'view.'+key,0);
}
const animations = {};
for (const a of document.getAnimations()) {
  const v = animations[a.animationName ?? a.constructor.name] ??= {count:0,keyframes:0,running:0};
  v.count++; v.keyframes += a.effect?.getKeyframes().length ?? 0; v.running += a.playState === 'running' ? 1 : 0;
}
return {counts,animations,elements:document.querySelectorAll('*').length,
  issueRows:document.querySelectorAll('[data-issue-row]').length,
  xterm:document.querySelectorAll('.xterm').length,canvas:document.querySelectorAll('canvas').length,
  workScroll:!!document.querySelector('[data-testid=work-scroll]'),
  visibility:document.visibilityState,
  resourceEntries:performance.getEntriesByType('resource').length,
  markEntries:performance.getEntriesByType('mark').length,
  measureEntries:performance.getEntriesByType('measure').length,
  jsHeapBytes:performance.memory?.usedJSHeapSize ?? null};
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--minutes', type=int, default=30)
    parser.add_argument('--driver-port', type=int, default=19586)
    parser.add_argument('--driver-binary', default='/System/Volumes/Preboot/Cryptexes/App/usr/bin/safaridriver')
    parser.add_argument('--native-at', type=int, default=3)
    parser.add_argument('--pause-css-at', type=int, default=-1)
    parser.add_argument('--synthetic', action='store_true', help='Public-code/generated-text fixture; no credentials or backend')
    parser.add_argument('--freeze-index-at', type=int, default=-1)
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    token = None if args.synthetic else sys.stdin.readline().strip()
    if not args.synthetic and not token: raise RuntimeError('Missing private session credential on stdin')
    with socket.socket() as check: check.bind(('127.0.0.1',args.driver_port))
    before = processes()
    driver = subprocess.Popen([args.driver_binary,'-p',str(args.driver_port)],
                              stdout=open(out/'driver.log','wb'),stderr=subprocess.STDOUT)
    owned = [{'pid':driver.pid,'role':'driver'}]
    def save(name,value): (out/name).write_text(json.dumps(value,indent=2))
    save('owned-pids.json',owned)
    base = f'http://127.0.0.1:{args.driver_port}'
    session = None; owner = None; owner_started = False; page_pid = None; samples = []
    try:
        deadline = time.monotonic()+30
        while True:
            try: request(base,'GET','/status',timeout=2); break
            except Exception:
                if time.monotonic()>deadline or driver.poll() is not None: raise RuntimeError('Owned safaridriver did not start')
                time.sleep(.2)
        created = request(base,'POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'safari'}}},timeout=30)
        session = created['sessionId']; base += '/session/'+session
        save('capabilities.json',created['capabilities'])
        if not args.synthetic:
            request(base,'POST','/url',{'url':args.url+'auth/status'})
            request(base,'POST','/cookie',{'cookie':{'name':'podium_session','value':token,'path':'/'}})
        token = None
        request(base,'POST','/window/rect',{'width':1600,'height':1000})
        request(base,'POST','/url',{'url':args.url+'?e2e=1'})
        after = processes()
        owners = [pid for pid,info in after.items() if pid not in before and
                  info['command'].split(None,1)[0].endswith('/Safari.app/Contents/MacOS/Safari') and '--automation' in info['command'].split()]
        owner_started = bool(owners)
        if not owners:
            owners = [pid for pid,info in after.items() if pid in before and
                      info['command'].split(None,1)[0].endswith('/Safari.app/Contents/MacOS/Safari')]
        if len(owners)!=1: raise RuntimeError('Could not establish unique Safari application; refusing ambiguous attribution')
        owner = owners[0]; owned.append({'pid':owner,'role':'Safari','started':owner_started,'command':after[owner]['command']}); save('owned-pids.json',owned)
        execute = lambda script: request(base,'POST','/execute/sync',{'script':script,'args':[]})
        deadline = time.monotonic()+180
        ready = 'return !!window.__memorySynthetic' if args.synthetic else 'return !!document.querySelector("[data-testid=work-scroll]")'
        while not execute(ready):
            if time.monotonic()>deadline: raise RuntimeError('Production UI did not hydrate')
            time.sleep(2)
        time.sleep(10)
        table = processes()
        candidates = [pid for pid,info in table.items() if info['command'].split(None,1)[0].endswith('/com.apple.WebKit.WebContent') and responsible(pid)==owner]
        if len(candidates)==1: page_pid = candidates[0]
        elif candidates:
            initial = {pid:cpu_time(pid) for pid in candidates}
            execute('const until=performance.now()+2500;let n=0;while(performance.now()<until)n+=Math.sqrt(n+1);return n')
            deltas = sorted(((cpu_time(pid) or 0)-(initial[pid] or 0),pid) for pid in candidates)
            save('page-attribution.json',{'cpuNanoseconds':[{'pid':pid,'delta':delta} for delta,pid in deltas]})
            if deltas[-1][0] < 1_000_000_000 or (len(deltas)>1 and deltas[-1][0] < 3*deltas[-2][0]):
                raise RuntimeError('Controlled page CPU burst did not establish unique WebContent attribution')
            page_pid = deltas[-1][1]
        if page_pid is None: raise RuntimeError('No responsible page process found')
        save('page-process.json',{'pid':page_pid,'Safari':owner,'SafariStarted':owner_started})
        if not args.synthetic: save('pool-found.json',{'found':execute(FIND_POOL)})
        started = time.monotonic()
        for minute in range(args.minutes+1):
            if minute == args.native_at:
                clicked = execute('const button=document.querySelector("[data-testid=mode-native]");button?.click();return !!button')
                print(json.dumps({'event':'native-click','clicked':clicked}),flush=True)
            if minute == args.pause_css_at:
                execute('const s=document.createElement("style");s.textContent="* { animation: none !important; transition: none !important }";document.head.append(s);return true')
            if minute == args.freeze_index_at:
                execute('window.__memorySynthetic.freeze();return true')
            left = started + minute*60 - time.monotonic()
            if left>0: time.sleep(left)
            table = processes()
            cohort = []
            for pid,info in table.items():
                if pid==page_pid and info['command'].split(None,1)[0].endswith('/com.apple.WebKit.WebContent') and responsible(pid)==owner:
                    if not any(p['pid']==pid for p in owned): owned.append({'pid':pid,'role':'WebContent','command':info['command']}); save('owned-pids.json',owned)
                    cohort.append({'pid':pid,'rssKiB':info['rssKiB'],'footprintBytes':footprint(pid)})
            value = {'minute':minute,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'processes':cohort,**execute(COUNTERS)}
            if args.synthetic: value['synthetic'] = execute('return window.__memorySynthetic.counts()')
            samples.append(value); save('samples.json',samples)
            print(json.dumps(value,separators=(',',':')),flush=True)
            if args.synthetic and any((p['footprintBytes'] or 0) > 3*1024**3 for p in cohort):
                raise RuntimeError('Synthetic capture reached its 3 GiB footprint budget')
    finally:
        if session:
            try: request(base,'DELETE','',timeout=10)
            except Exception: pass
        if driver.poll() is None:
            driver.terminate()
            try: driver.wait(timeout=5)
            except subprocess.TimeoutExpired: driver.kill(); driver.wait(timeout=5)
        if owner and owner_started:
            for item in owned:
                if item['pid']==owner and processes().get(owner,{}).get('command')==item['command']:
                    os.kill(owner,signal.SIGTERM)
        save('cleanup.json',{'driverExit':driver.returncode,'recordedPids':[p['pid'] for p in owned]})


if __name__ == '__main__':
    def stop(*_): raise KeyboardInterrupt('Owned capture interrupted')
    for s in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP): signal.signal(s,stop)
    main()
