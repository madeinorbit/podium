"""Recover the exact committed collector for earlier captures without changing observations."""
import hashlib
import json
import pathlib
import subprocess

source = 'apps/web/harness/old-vs-new.mjs'
snapshots = {}
for commit in subprocess.check_output(['git', 'log', '--format=%H', '--', source], text=True).splitlines():
    content = subprocess.check_output(['git', 'show', f'{commit}:{source}'])
    snapshots[hashlib.sha256(content).hexdigest()] = content

recovered = 0
for arm in ['old', 'new']:
    raw = pathlib.Path('docs/measurements/POD-4286-old-vs-new/raw') / arm
    for file in sorted(raw.glob('*/run.json')):
        run = json.loads(file.read_text())
        if run.get('purpose') != 'measurement':
            continue
        digest = run['harnessSha256']
        if digest not in snapshots:
            raise RuntimeError('No committed collector matches ' + file.parent.name)
        content = snapshots[digest]
        target = f'podium-test-5501-{arm}/.artifacts/old-vs-new/{file.parent.name}/harness-source.mjs'
        # Folder names come from our capture ledger, never arbitrary shell input.
        if any(character not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for character in file.parent.name):
            raise RuntimeError('Unexpected capture path')
        command = f'cat > "$HOME/{target}"'
        subprocess.run(['ssh', '-o', 'BatchMode=yes', 'flatblock', command], input=content, check=True)
        recovered += 1
print(json.dumps({'recoveredCollectorSnapshots': recovered}))
