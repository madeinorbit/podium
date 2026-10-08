#!/usr/bin/env python3
"""Launch the native capture and merge numeric WK counters with physical footprint.

Mac-only; stdin credential is sent to the child once and never saved.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', required=True)
parser.add_argument('--probe', required=True)
parser.add_argument('--url', required=True)
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--minutes', type=int, default=25)
args = parser.parse_args()
os.umask(0o077)
args.out.mkdir(parents=True, exist_ok=True)
responsible = ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid
responsible.argtypes = [ctypes.c_int]
responsible.restype = ctypes.c_int
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')

def processes(owner):
    lines = subprocess.check_output(['ps','-axww','-o','pid=,rss=,command='], text=True).splitlines()
    result = []
    for line in lines:
        pid, rss, command = line.strip().split(None,2)
        pid = int(pid)
        if pid != owner and responsible(pid) != owner: continue
        usage = ctypes.create_string_buffer(512)
        fp = None if libproc.proc_pid_rusage(pid,4,usage) else ctypes.c_uint64.from_buffer(usage,72).value
        result.append({'pid':pid,'rssKiB':int(rss),'footprintBytes':fp,'role':'app' if pid == owner else 'webcontent' if '/com.apple.WebKit.WebContent' in command else 'auxiliary'})
    return result

child = subprocess.Popen([args.binary,args.url,str(args.out),args.probe,str(args.minutes)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(args.out/'native-errors.log','wb'), text=True)
(args.out/'owned-meter.json').write_text(json.dumps({'pid':os.getpid(),'app':child.pid}))
child.stdin.write(sys.stdin.readline())
child.stdin.close()
try:
    with (args.out/'curve.jsonl').open('w') as curve:
        for line in child.stdout:
            try: value = json.loads(line)
            except ValueError: continue
            value['processes'] = processes(child.pid)
            value['uptimeSeconds'] = time.monotonic()
            curve.write(json.dumps(value)+'\n'); curve.flush()
            print(json.dumps(value), flush=True)
            if max((p['footprintBytes'] or 0 for p in value['processes']),default=0) > 7*1024**3:
                print(json.dumps({'event':'budget-stop','pid':child.pid}),flush=True)
                break
finally:
    if child.poll() is None:
        child.terminate()
    child.wait(timeout=20)
