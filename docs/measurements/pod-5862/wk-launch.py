#!/usr/bin/env python3
"""Mac-only detached collector launcher; credential stays in an unnamed pipe.

Profiling must survive SSH transport failure. Tests still run in the foreground
on flatblock; this launcher is only for the leased native runtime capture.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--url',required=True)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--minutes',type=int,default=25)
a=p.parse_args()
os.umask(0o077)
a.out.mkdir(parents=True,exist_ok=True)
child=subprocess.Popen([sys.executable,str(a.root/'wk-meter.py'),'--binary',str(a.root/'wk-capture'),'--probe',str(a.root/'wk-probe.js'),'--url',a.url,'--out',str(a.out),'--minutes',str(a.minutes)],
    stdin=subprocess.PIPE,stdout=open(a.out/'collector-stdout.jsonl','wb'),stderr=open(a.out/'collector-errors.log','wb'),start_new_session=True)
child.stdin.write(sys.stdin.buffer.readline());child.stdin.close()
(a.out/'owned-launch.json').write_text(json.dumps({'meter':child.pid}))
print(json.dumps({'meter':child.pid}),flush=True)
