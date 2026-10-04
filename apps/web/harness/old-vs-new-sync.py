"""Copy completed evidence metadata; retain explicit exclusions without changing observations."""
import pathlib
import subprocess
import tarfile

root = pathlib.Path('docs/measurements/POD-4286-old-vs-new/raw')
root.mkdir(parents=True, exist_ok=True)
remote = '''import io,json,tarfile,sys
from pathlib import Path
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as tar:
 for arm in ['old','new']:
  root=Path.home()/f'podium-test-5501-{arm}/.artifacts/old-vs-new'
  for folder in root.iterdir():
   file=folder/'run.json'
   if not file.is_file():continue
   try:run=json.loads(file.read_text())
   except json.JSONDecodeError:continue
   if run['status']=='running':continue
   if run['mode']=='timing' and run['surface']=='web' and run['scale']==1 and run['round'] in [10,11] and run.get('comparisonArm')=='new':
    run['backgroundSuperseded']=True
    run['backgroundExcludedReason']='Repeat paired 1x background windows with complete OLD logical issue updates and a fresh matched resident-pane state.'
    file.write_text(json.dumps(run,indent=2)+'\\n')
   if folder.name=='timing-old-web-4x-r10' and run['harnessSha256']=='e0d8a84eb2258bd15f31022a7a78b33e700e119aed4de6faa61a24ef25f9a0c3' and 'Comparison target A' in run.get('failure',''):
    run['actionPhaseComplete']=True
    run['backgroundSuperseded']=True
    run['backgroundExcludedReason']='Completed action phase retained; background preparation waited for the original title after optimistic rename. Repeat paired background windows separately.'
    file.write_text(json.dumps(run,indent=2)+'\\n')
   if folder.name=='timing-new-web-4x-r10' and run['sha']=='1aa0ec71f68c5c6569560798db00a82a1db9f82d':
    run['backgroundSuperseded']=True
    run['backgroundExcludedReason']='Contemporary OLD background preparation failed; use the second pair and a separate matched background-only pair.'
    file.write_text(json.dumps(run,indent=2)+'\\n')
   for name in ['run.json','cpu-attribution.json','cpu-boundaries.json']:
    source=folder/name
    if source.is_file():
     data=source.read_bytes();info=tarfile.TarInfo(f'{arm}/{folder.name}/{name}');info.size=len(data);tar.addfile(info,io.BytesIO(data))
'''
child = subprocess.Popen(['ssh', 'flatblock', "python3 - <<'PY'\n" + remote + '\nPY'], stdout=subprocess.PIPE)
with tarfile.open(fileobj=child.stdout, mode='r|') as archive:
    # The remote script emits only these metadata paths, never captured product
    # or operator files. Reject any path that could escape the report directory.
    for member in archive:
        parts = pathlib.PurePosixPath(member.name).parts
        if len(parts) != 3 or parts[0] not in ['old', 'new'] or '..' in parts or not member.isfile():
            raise RuntimeError('Unexpected evidence path: ' + member.name)
        target = root.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
if child.wait():
    raise RuntimeError('Remote evidence copy failed')
subprocess.run(['python3', 'apps/web/harness/old-vs-new-report.py'], check=True)
