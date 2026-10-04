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
args=parser.parse_args()
surfaces=['web','phone'] if args.surface=='both' else [args.surface]
scales=['1','4'] if args.scale=='both' else [args.scale]
for surface in surfaces:
    for scale in scales:
        for round in args.rounds.split(','):
            for arm in ['old',args.new_arm]:
                command=[sys.executable,'apps/web/harness/old-vs-new-remote.py','--arm',arm,'--checkout-arm','old' if arm=='old' else 'new','--surface',surface,'--scale',scale,'--mode',args.mode,'--round',round,'--samples',args.samples,'--comparison-arm',args.new_arm]
                print('NEXT '+' '.join(command),flush=True)
                result=subprocess.run(command)
                # A failed OLD phone startup is retained as absence of evidence;
                # its NEW neighbour still runs. Other failures stop the matrix.
                if result.returncode and not (arm=='old' and surface=='phone'):
                    sys.exit(result.returncode)
