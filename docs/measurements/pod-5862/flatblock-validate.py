#!/usr/bin/env python3
"""Foreground validation with exact recorded descendant PIDs and RSS evidence.

Ordinary test processes stop at 3 GB. Structural mode checks the operator's
host memory/swap limits instead. Typecheck/build have no ordinary-worker cap.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--test',action='store_true')
p.add_argument('--structural',action='store_true')
p.add_argument('command',nargs=argparse.REMAINDER)
a=p.parse_args()
assert Path.cwd().name=='podium-test-5862'
command=a.command[1:] if a.command[:1]==['--'] else a.command
assert command and command[0] in ('.toolchain/bun','bun')
def info(pid):
    try:
        fields=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
        rss=int(next(s.split()[1] for s in Path(f'/proc/{pid}/status').read_text().splitlines() if s.startswith('VmRSS:')))*1024
        command=Path(f'/proc/{pid}/cmdline').read_bytes()
        worker=any(marker in command for marker in (b'vitest.mjs',b'vitest/dist',b'tinypool'))
        return {'pid':pid,'parent':int(fields[1]),'start':fields[19],'rss':rss,'testWorker':worker}
    except (OSError,StopIteration):return None
def host():
    v={line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line}
    return {'available':v['MemAvailable'],'swapUsed':v['SwapTotal']-v['SwapFree']}
assert host()['available']>=6*1024**3,'Flatblock admission below 6 GiB'
a.out.parent.mkdir(parents=True,exist_ok=True)
child=subprocess.Popen(command)
owned={}
peaks={}
done=threading.Event()
violation=None
def monitor():
    global violation
    while not done.is_set():
        todo=[child.pid]
        for pid in todo:
            value=info(pid)
            if value:
                owned[pid]=value
                peaks[pid]=max(peaks.get(pid,0),value['rss'])
                try:
                    for children in Path(f'/proc/{pid}/task').glob('*/children'):
                        try:todo.extend(int(v) for v in children.read_text().split() if int(v) not in todo)
                        except OSError:pass
                except OSError:pass
        memory=host()
        live=[]
        for pid,v in owned.items():
            current=info(pid)
            if current and current['start']==v['start']:live.append(current)
        if a.test and any(v['testWorker'] and v['rss']>3_000_000_000 for v in live):
            violation='ordinary test process above 3 GB'
        if a.structural and (memory['available']<1.5*1024**3 or memory['swapUsed']>12*1024**3):
            violation='structural host memory/swap limit'
        a.out.write_text(json.dumps({'owned':list(owned.values()),'peakRss':peaks,'host':memory,'violation':violation}))
        if violation:
            print(json.dumps({'budgetStop':violation,'host':memory}),flush=True)
            for pid,v in reversed(list(owned.items())):
                current=info(pid)
                if current and current['start']==v['start']:
                    try:os.kill(pid,signal.SIGTERM)
                    except ProcessLookupError:pass
            return
        done.wait(.25)
t=threading.Thread(target=monitor,daemon=True);t.start()
code=child.wait()
done.set();t.join()
result={'owned':list(owned.values()),'peakRss':peaks,'host':host(),'violation':violation,'validationExit':code}
a.out.write_text(json.dumps(result))
print(json.dumps({'validationExit':code,'maximumProcessRss':max(peaks.values(),default=0),'budgetStop':violation}),flush=True)
raise SystemExit(2 if violation else code)
