#!/usr/bin/env python3
"""Read rusage for already-proven native app/page PIDs; no argv/process scan.

Only samples less than five seconds old are paired with current memory values.
"""
import argparse
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--app',type=int,required=True)
p.add_argument('--page',type=int,required=True)
p.add_argument('--minutes',type=int,default=25)
a=p.parse_args()
os.umask(0o077)
libproc=ctypes.CDLL('/usr/lib/libproc.dylib')
(a.out/'owned-attached-meter.json').write_text(json.dumps({'pid':os.getpid(),'app':a.app,'page':a.page}))
seen=set()
with (a.out/'curve-attached.jsonl').open('w') as curve:
    while True:
        files=sorted(a.out.glob('sample-*.json'),key=lambda f:int(f.stem.split('-')[-1]))
        for f in files:
            if f.name in seen:continue
            seen.add(f.name)
            value=json.loads(f.read_text())
            age=time.time()-datetime.fromisoformat(value['at'].replace('Z','+00:00')).timestamp()
            if age>5:continue
            stats=[]
            for pid,role in ((a.app,'app'),(a.page,'webcontent')):
                usage=ctypes.create_string_buffer(512)
                if libproc.proc_pid_rusage(pid,4,usage):raise RuntimeError('Proven PID exited; refusing attribution to a replacement')
                stats.append({'pid':pid,'role':role,'residentBytes':ctypes.c_uint64.from_buffer(usage,64).value,'footprintBytes':ctypes.c_uint64.from_buffer(usage,72).value})
            value.update(processes=stats,capturedAt=datetime.now(timezone.utc).isoformat(),sampleAgeSeconds=age)
            curve.write(json.dumps(value)+'\n');curve.flush()
            print(json.dumps(value),flush=True)
            if max(s['footprintBytes'] for s in stats)>7*1024**3:
                print(json.dumps({'event':'budget-stop','app':a.app}),flush=True)
                os.kill(a.app,15)
                raise SystemExit(2)
            if value['minute']>=a.minutes:raise SystemExit(0)
        time.sleep(.5)
