"""Attach checksummed archive parts within Podium's 100 MB per-file limit."""
import hashlib
import json
import pathlib
import subprocess

manifest_path = pathlib.Path('docs/measurements/POD-4286-old-vs-new/archives.json')
manifest = json.loads(manifest_path.read_text())
for archive in manifest:
    file = pathlib.Path(archive['path'])
    if archive.get('attached'):
        continue
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            digest.update(chunk)
    if digest.hexdigest() != archive['sha256'] or file.stat().st_size != archive['bytes']:
        raise RuntimeError('Archive changed: ' + str(file))
    parts = archive.setdefault('parts', [])
    limit = 90 * 1048576
    count = (archive['bytes'] + limit - 1) // limit
    with file.open('rb') as stream:
        for index in range(count):
            content = stream.read(limit)
            part = pathlib.Path(str(file) + f'.part{index + 1:03d}') if count > 1 else file
            if count > 1:
                part.write_bytes(content)
            checksum = hashlib.sha256(content).hexdigest()
            previous = next((row for row in parts if row['path'] == str(part)), None)
            if previous:
                if previous['sha256'] != checksum:
                    raise RuntimeError('Attached part changed: ' + str(part))
                continue
            title = f'Raw {archive["arm"]} {archive["kind"]} evidence — part {index + 1}/{count}'
            result = subprocess.run(['podium', 'issue', 'artifact', 'POD-5501', '--add', str(part),
                                     '--title', title, '--json'], capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            response = json.loads(result.stdout)
            if not response.get('ok'):
                raise RuntimeError(response)
            attached = response.get('data', response)
            if isinstance(attached, list):
                attached = next(row for row in attached if row.get('path') == str(part))
            parts.append({'path': str(part), 'bytes': len(content), 'sha256': checksum,
                          'attachment': attached})
            manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
            print(json.dumps({'path': str(part), 'bytes': len(content), 'attached': True}), flush=True)
    archive['attached'] = True
    archive['reassembly'] = 'Concatenate numbered parts in order, verify archive SHA-256, then extract tar.gz.'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
