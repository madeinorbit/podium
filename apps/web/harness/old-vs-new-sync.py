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
