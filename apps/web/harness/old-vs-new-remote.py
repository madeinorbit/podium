"""Run one flatblock arm in foreground; hold the ludovico lease only for capture."""
import argparse
import datetime
import json
import pathlib
import re
import shlex
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--arm', required=True)
parser.add_argument('--checkout-arm', choices=['old', 'new'])
parser.add_argument('--comparison-arm')
parser.add_argument('--surface', choices=['web', 'phone'], default='web')
parser.add_argument('--scale', choices=['1','4'], default='1')
parser.add_argument('--mode', choices=['probe','timing','memory'], default='probe')
parser.add_argument('--round', default='0')
parser.add_argument('--samples', default='8')
parser.add_argument('--control-only', action='store_true')
args=parser.parse_args()
checkout=f'podium-test-5501-{args.checkout_arm or args.arm}'
relative=f'.artifacts/old-vs-new/{args.mode}-{args.arm}-{args.surface}-{args.scale}x-r{args.round}'
name='bench:flatblock' if args.mode=='timing' else 'meter:flatblock'
argv=['--external-lease',f'--mode={args.mode}',f'--arm={args.arm}',f'--surface={args.surface}',f'--scale={args.scale}',f'--round={args.round}',f'--samples={args.samples}',f'--comparison-arm={args.comparison_arm or ("new" if args.arm=="old" else args.arm)}',f'--out={relative}']
if args.control_only:argv.append('--control-only')
command=f'cd "$HOME/{checkout}" && export PATH="$PWD/.toolchain:$PATH" && export LD_LIBRARY_PATH="$PWD/.toolchain/lib" && exec .toolchain/bun --conditions=@podium/source apps/web/harness/old-vs-new.mjs '+shlex.join(argv)
child=subprocess.Popen(['ssh','-o','BatchMode=yes','flatblock',command],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
held=False
root=pathlib.Path('.artifacts/old-vs-new-remote')
root.mkdir(parents=True,exist_ok=True)
log=root/(pathlib.Path(relative).name+'.log')
try:
    with log.open('w') as output:
        for line in child.stdout:
            if not re.match(r'^[a-z-]+: [0-9]+\.[0-9]+ ms',line):print(line,end='',flush=True)
            output.write(line);output.flush()
            if line.startswith('CAPTURE_READY '):
                # OLD 4x can spend more than twenty minutes in its foreground
                # action matrix. The lease still ends at CAPTURE_FINISHED.
                acquired=subprocess.run(['podium','lock','acquire',name,'--ttl','45m','--wait','--json'],capture_output=True,text=True,check=True)
                grant=json.loads(acquired.stdout)
                if not grant.get('data',{}).get('granted'):raise RuntimeError('Capture lease not granted')
                held=True
                payload=json.dumps({'name':name,'host':'ludovico','acquiredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'grant':grant})
                write=f'cat > "$HOME/{checkout}/{relative}/lease.pending" && mv "$HOME/{checkout}/{relative}/lease.pending" "$HOME/{checkout}/{relative}/lease.json"'
                subprocess.run(['ssh','-o','BatchMode=yes','flatblock',write],input=payload,text=True,check=True)
                print(grant.get('text','lease acquired'),flush=True)
            if line.startswith('CAPTURE_FINISHED ') and held:
                subprocess.run(['podium','lock','release',name],check=True)
                held=False
    code=child.wait()
finally:
    if held:subprocess.run(['podium','lock','release',name],check=True)
    if child.poll() is None:
        # This is our recorded foreground SSH process, never a pattern kill.
        child.terminate();child.wait(timeout=20)
sys.exit(code)
