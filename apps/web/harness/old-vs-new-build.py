"""Preserve the exact built assets and source maps before changing a measured revision."""
import datetime
import hashlib
import json
import pathlib
import shutil
import socket
import subprocess

checkout = pathlib.Path.cwd()
if socket.gethostname() != 'flatblock' or checkout.name not in ['podium-test-5501-old', 'podium-test-5501-new']:
    raise RuntimeError('Only the two isolated flatblock comparison checkouts are supported')
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
target = checkout / '.artifacts/old-vs-new/builds' / sha
if target.exists():
    raise RuntimeError('Build evidence already exists; do not overwrite its provenance')
target.mkdir(parents=True)
files = []
for surface, directory in [('web', 'apps/web/dist'), ('phone', 'apps/mobile/dist')]:
    source = checkout / directory
    if not source.is_dir():
        raise RuntimeError('Missing measured production build: ' + directory)
    shutil.copytree(source, target / surface)
(target / 'inputs').mkdir()
for scale in [1, 4]:
    for kind in ['corpus', 'rows', 'validation']:
        name = f'{kind}-{scale}x.json'
        shutil.copy2(checkout / '.artifacts/old-vs-new' / name, target / 'inputs' / name)
for file in sorted(target.rglob('*')):
    if file.is_file():
        files.append({'path': str(file.relative_to(target)), 'bytes': file.stat().st_size,
                      'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
manifest = {'sha': sha, 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'host': socket.gethostname(), 'files': files}
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sha': sha, 'assets': len(files), 'bytes': sum(file['bytes'] for file in files)}))
