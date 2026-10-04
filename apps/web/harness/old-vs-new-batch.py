"""Foreground sequential ABAB matrix; every child owns only its capture lease."""
import argparse
import subprocess
import sys

parser=argparse.ArgumentParser()
parser.add_argument('--mode',choices=['timing','memory'],required=True)
parser.add_argument('--surface',choices=['web','phone','both'],default='both')
parser.add_argument('--scale',choices=['1','4','both'],default='both')
parser.add_argument('--new-arm',default='new')
parser.add_argument('--rounds',default='0,1')
parser.add_argument('--samples',default='8')
parser.add_argument('--background-only',action='store_true')
parser.add_argument('--new-only',action='store_true',help='Explicit coordinator scope reduction; no matched OLD attempt')
parser.add_argument('--start-at',help='Resume at arm:surface:scale:round, retaining completed earlier captures')
args=parser.parse_args()
started=not args.start_at
surfaces=['web','phone'] if args.surface=='both' else [args.surface]
scales=['1','4'] if args.scale=='both' else [args.scale]
for surface in surfaces:
    for scale in scales:
        for round in args.rounds.split(','):
            for arm in ([args.new_arm] if args.new_only else ['old',args.new_arm]):
                if not started:
                    started=f'{arm}:{surface}:{scale}:{round}'==args.start_at
                    if not started:continue
                command=[sys.executable,'apps/web/harness/old-vs-new-remote.py','--arm',arm,'--checkout-arm','old' if arm=='old' else 'new','--surface',surface,'--scale',scale,'--mode',args.mode,'--round',round,'--samples',args.samples,'--comparison-arm',args.new_arm]
                if args.background_only:command.append('--background-only')
                print('NEXT '+' '.join(command),flush=True)
                result=subprocess.run(command)
                # A failed OLD phone startup is retained as absence of evidence;
                # its NEW neighbour still runs. Other failures stop the matrix.
                if result.returncode and not (result.returncode==2 and arm=='old' and surface=='phone'):
                    sys.exit(result.returncode)
if not started:raise SystemExit('Requested start point is not in this matrix')
