"""Run one flatblock arm in foreground; hold the ludovico lease only for capture."""
import argparse
import datetime
import json
import pathlib
import re
import shlex
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--arm', required=True)
parser.add_argument('--checkout-arm', choices=['old', 'new', 'experiments'])
parser.add_argument('--comparison-arm')
parser.add_argument('--surface', choices=['web', 'phone'], default='web')
parser.add_argument('--scale', choices=['1','4'], default='1')
parser.add_argument('--mode', choices=['probe','timing','memory'], default='probe')
parser.add_argument('--round', default='0')
parser.add_argument('--samples', default='8')
parser.add_argument('--variants')
parser.add_argument('--query', default='')
parser.add_argument('--control-only', action='store_true')
parser.add_argument('--background-only', action='store_true')
args=parser.parse_args()
checkout=f'podium-test-5513-{args.checkout_arm or args.arm}'
relative=f'.artifacts/old-vs-new/{args.mode}-{args.arm}-{args.surface}-{args.scale}x-r{args.round}'
name='bench:flatblock' if args.mode=='timing' else 'meter:flatblock'
argv=['--external-lease',f'--mode={args.mode}',f'--arm={args.arm}',f'--surface={args.surface}',f'--scale={args.scale}',f'--round={args.round}',f'--samples={args.samples}',f'--comparison-arm={args.comparison_arm or ("new" if args.arm=="old" else args.arm)}',f'--out={relative}']
if args.control_only:argv.append('--control-only')
if args.background_only:argv.append('--background-only')
if args.variants:argv.append('--variants='+args.variants)
if args.query:argv.append('--query='+args.query)
command=f'cd "$HOME/{checkout}" && export PATH="$PWD/.toolchain:$PATH" && export LD_LIBRARY_PATH="$PWD/.toolchain/lib" && exec .toolchain/bun --conditions=@podium/source apps/web/harness/cold-start.mjs '+shlex.join(argv)
child=subprocess.Popen(['ssh','-o','BatchMode=yes','flatblock',command],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
held=False
failure=None
observations=0
root=pathlib.Path('.artifacts/cold-start-remote')
root.mkdir(parents=True,exist_ok=True)
log=root/(pathlib.Path(relative).name+'.log')
try:
    with log.open('w') as output:
        for line in child.stdout:
            if re.match(r'^[a-z-]+: [0-9]+\.[0-9]+ ms',line):
                observations+=1
                if observations%20==0:print(f'PROGRESS {pathlib.Path(relative).name}: {observations} action observations; latest {line.strip()}',flush=True)
            else:print(line,end='',flush=True)
            if line.startswith('{"status":'):
                failure=json.loads(line).get('failure')
            output.write(line);output.flush()
            if line.startswith('CAPTURE_READY '):
                # Preparation and builds never hold the timing lease.
                for attempt in range(5):
                    acquired=subprocess.run(['podium','lock','acquire',name,'--ttl','10m','--wait','--json'],capture_output=True,text=True)
                    if acquired.returncode==0:break
                    print(f'Lease client attempt {attempt+1} failed: {acquired.stderr.strip()}',flush=True)
                    time.sleep(2)
                acquired.check_returncode()
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
except Exception:
    # A relay can disconnect after granting the lock but before printing JSON.
    # Release is ownership-checked by Podium; it cannot release another holder.
    if not held:
        subprocess.run(['podium','lock','release',name],capture_output=True,text=True)
    # Closing SSH alone does not reap a remote process waiting for its lease.
    # Use only the PIDs recorded by this invocation, and verify their checkout.
    cleanup='''from pathlib import Path
import datetime,json,os,signal,time
checkout=Path.home()/CHECKOUT
file=checkout/RELATIVE/'run.json'
if file.is_file():
 run=json.loads(file.read_text())
 pids=run.get('pids',[])
 for entry in sorted(pids,key=lambda p:p['role']=='collector'):
  pid=entry['pid']
  try:
   if Path(os.readlink(f'/proc/{pid}/cwd'))!=checkout:raise RuntimeError('Recorded PID ownership changed')
   os.kill(pid,signal.SIGTERM)
  except FileNotFoundError:pass
  time.sleep(1)
 if not run.get('captureStartedAt') and not run.get('lease'):
  run.update(originalPurpose=run['purpose'],purpose='preparation-failure',status='failed',excludedReason='Lease controller failed before capture; recorded processes were cleaned.',endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
  file.write_text(json.dumps(run,indent=2)+'\\n')
 print('Cleaned recorded PIDs',pids)
'''.replace('CHECKOUT',repr(checkout)).replace('RELATIVE',repr(relative))
    subprocess.run(['ssh','-o','BatchMode=yes','flatblock','python3 -c '+shlex.quote(cleanup)],check=True)
    raise
finally:
    if held:subprocess.run(['podium','lock','release',name],check=True)
    if child.poll() is None:
        # This is our recorded foreground SSH process, never a pattern kill.
        child.terminate();child.wait(timeout=20)
sys.exit(2 if code and args.arm=='old' and args.surface=='phone' and failure and '185' in failure else code)
