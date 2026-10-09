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
class Timebase(ctypes.Structure):
    _fields_ = [('numer',ctypes.c_uint32),('denom',ctypes.c_uint32)]
timebase = Timebase()
ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(ctypes.byref(timebase))
page_pid = None

def processes(owner, candidates=False):
    lines = subprocess.check_output(['ps','-axww','-o','pid=,rss=,comm='], text=True).splitlines()
    result = []
    for line in lines:
        pid, rss, command = line.strip().split(None,2)
        pid = int(pid)
        webcontent = '/com.apple.WebKit.WebContent' in command
        if pid != owner and responsible(pid) != owner and pid != page_pid and not (candidates and webcontent): continue
        usage = ctypes.create_string_buffer(512)
        fp = None if libproc.proc_pid_rusage(pid,4,usage) else ctypes.c_uint64.from_buffer(usage,72).value
        cpu = sum(ctypes.c_uint64.from_buffer(usage,offset).value for offset in (16,24))*timebase.numer/timebase.denom
        result.append({'pid':pid,'rssKiB':int(rss),'footprintBytes':fp,'cpuNanoseconds':cpu,'responsible':responsible(pid),'role':'app' if pid == owner else 'webcontent' if webcontent else 'auxiliary'})
    return result

child = subprocess.Popen([args.binary,args.url,str(args.out),args.probe,str(args.minutes)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(args.out/'native-errors.log','wb'), text=True)
(args.out/'owned-meter.json').write_text(json.dumps({'pid':os.getpid(),'app':child.pid}))
child.stdin.write(sys.stdin.readline())
child.stdin.close()
try:
    initial_cpu = {}
    with (args.out/'curve.jsonl').open('w') as curve:
        for line in child.stdout:
            try: value = json.loads(line)
            except ValueError: continue
            if value.get('event') == 'attribution-start':
                initial_cpu = {p['pid']:p['cpuNanoseconds'] for p in processes(child.pid,True) if p['role']=='webcontent'}
                continue
            if value.get('event') == 'attribution-end':
                deltas = sorted((p['cpuNanoseconds']-initial_cpu.get(p['pid'],p['cpuNanoseconds']),p['pid']) for p in processes(child.pid,True) if p['role']=='webcontent')
                if not deltas or deltas[-1][0]<1_000_000_000 or (len(deltas)>1 and deltas[-1][0]<3*deltas[-2][0]):
                    raise RuntimeError('CPU burst did not prove page attribution')
                page_pid = deltas[-1][1]
                value['cpuDeltas'] = [{'pid':pid,'nanoseconds':delta} for delta,pid in deltas]
                (args.out/'page-attribution.json').write_text(json.dumps(value))
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
