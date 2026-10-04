"""Export bounded sets of synthetic capture evidence, never server logs or agent state."""
import argparse
import hashlib
import json
import pathlib
import shlex
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--arm', choices=['old', 'new'], required=True)
parser.add_argument('--kind', choices=['new', 'new-deleted', 'new-current', 'builds', 'diagnostics'], required=True)
args = parser.parse_args()
output = pathlib.Path('docs/measurements/POD-4286-old-vs-new/archives')
output.mkdir(parents=True, exist_ok=True)
target = output / f'{args.arm}-{args.kind}.tar.gz'
if target.exists():
    raise RuntimeError('Evidence archive already exists; do not silently replace it')

remote = '''import hashlib,io,json,pathlib,sys,tarfile
arm=ARM
kind=KIND
root=pathlib.Path.home()/f'podium-test-5501-{arm}/.artifacts/old-vs-new'
selected=[]
if kind=='builds':
 selected=sorted((root/'builds').rglob('*'))
else:
 for folder in sorted(root.iterdir()):
  file=folder/'run.json'
  if not file.is_file():continue
  run=json.loads(file.read_text())
  if run['status']=='running':raise RuntimeError('A capture is still running: '+folder.name)
  measurement=run.get('purpose')=='measurement'
  if kind=='diagnostics':
   if measurement:continue
  elif not measurement or run.get('comparisonArm')!=kind:continue
  for file in sorted(folder.iterdir()):
   if (file.name in ['run.json','cpu-attribution.json','cpu-boundaries.json','harness-source.mjs','browser-paint-source.ts']
       or file.name.endswith(('.trace.json.gz','.cpuprofile','.png','.html'))):selected.append(file)
entries=[]
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as archive:
 for file in selected:
  if file.is_symlink():raise RuntimeError('Unexpected evidence symlink')
  if not file.is_file():continue
  relative=f'{arm}/'+str(file.relative_to(root))
  digest=hashlib.sha256()
  with file.open('rb') as data:
   for chunk in iter(lambda:data.read(1024*1024),b''):digest.update(chunk)
  entries.append({'path':relative,'bytes':file.stat().st_size,'sha256':digest.hexdigest()})
  archive.add(file,arcname=relative,recursive=False)
 manifest=json.dumps({'arm':arm,'kind':kind,'files':entries},indent=2).encode()
 info=tarfile.TarInfo('evidence-manifest.json');info.size=len(manifest)
 archive.addfile(info,io.BytesIO(manifest))
'''.replace('ARM', repr(args.arm)).replace('KIND', repr(args.kind))
with target.open('wb') as file:
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'flatblock', 'python3 -c ' + shlex.quote(remote)], stdout=file)
if result.returncode:
    target.unlink()
    raise RuntimeError('Evidence export failed')
digest = hashlib.sha256()
with target.open('rb') as file:
    for chunk in iter(lambda: file.read(1024 * 1024), b''):
        digest.update(chunk)
manifest_path = output.parent / 'archives.json'
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
manifest.append({'path': str(target), 'arm': args.arm, 'kind': args.kind,
                 'bytes': target.stat().st_size, 'sha256': digest.hexdigest()})
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest[-1]))
