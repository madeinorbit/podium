"""The exact POD-7164 storage reopen collector, with optional CPU/loader evidence.
Run through remote-lane on the assigned measurement host, with a maximum 30-minute lease.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
COLLECTOR = 'be437fae00d2752a431117c584d8c8fa4498d06b'
parser = argparse.ArgumentParser()
parser.add_argument('--arm', required=True)
parser.add_argument('--host', required=True)
parser.add_argument('--lease', required=True)
parser.add_argument('--samples', type=int, default=1)
parser.add_argument('--profile', action='store_true')
parser.add_argument('--prepare-only', action='store_true')
args = parser.parse_args()
if Path.cwd().parent != Path.home() or not Path.cwd().name.startswith('podium-test-'):
    raise SystemExit('Run in the isolated checkout prepared by remote-lane')
spec = importlib.util.spec_from_file_location('baseline', HERE / 'data-on-device-baseline.py')
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)
root = Path.cwd() / '.artifacts/deck-disk' / args.arm
root.mkdir(parents=True, exist_ok=False)
# Preserve the exact original collector and the small, explicit profile extension.
for name in ['cold-start.mjs', 'storage-reopens.mjs', 'offline-route-guard.mjs']:
    text = subprocess.run(['git', 'show', f'{COLLECTOR}:apps/web/harness/{name}'], check=True, capture_output=True, text=True).stdout
    (root / ('original-' + name)).write_text(text)
    if name == 'storage-reopens.mjs':
        text = text.replace("    const stop = await trace(f.cdp)", """    const profile = process.argv.includes('--disk-profile')
    if (profile) {
      await f.cdp.send('Profiler.enable')
      await f.cdp.send('Profiler.setSamplingInterval', {interval: 100})
      await f.cdp.send('Profiler.start')
    }
    await f.page.evaluate(() => {
      globalThis.__diskProfile = {active:true, events:[], counts:{}, frames:[]}
      const frame = (at) => {
        const p = globalThis.__diskProfile
        if (!p.active) return
        p.frames.push(at)
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    const stop = await trace(f.cdp)""")
        text = text.replace('    const events = await stop()', """    const events = await stop()
    if (profile) {
      const cpu = (await f.cdp.send('Profiler.stop')).profile
      record.cpu = `reopen-${screen}-${phase}.cpuprofile`
      writeFileSync(resolve(out, record.cpu), JSON.stringify(cpu))
    }
    record.loaderTimeline = await f.page.evaluate(() => {
      globalThis.__diskProfile.active = false
      return globalThis.__diskProfile
    })""")
    (HERE / name).write_text(text)
    (root / name).write_text(text)
baseline.sh('bun x playwright install chromium', Path.cwd())
baseline.chromium_libraries()
baseline.sh('PATH="$PATH:$HOME/.cargo/bin" bun --conditions=@podium/source -e '\
    + "'const {resolveHostBin}=await import(\"./packages/pty/src/host-bin.ts\"); console.log(resolveHostBin())'", Path.cwd())
if args.profile:
    baseline.sh('bun apps/web/harness/deck-disk-profile-build.mjs', Path.cwd())
    baseline.sh('bun --conditions=@podium/source scripts/write-web-build-stamp.ts apps/web/dist', Path.cwd())
else:
    baseline.sh('bun run --cwd apps/web build', Path.cwd())
baseline.sh('bun --conditions=@podium/source apps/web/harness/old-vs-new-corpus.mjs --cell=operator', Path.cwd())
if args.prepare_only:
    raise SystemExit(0)
exits = []
for sample in range(args.samples):
    out = root / f'sample-{sample}'
    out.mkdir()
    (out / 'lease.json').write_text(json.dumps({'name':args.lease, 'host':args.host, 'heldBy':'remote-lane'}))
    argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/cold-start.mjs', '--external-lease', '--mode=timing',
        '--arm=' + args.arm, '--cell=operator', '--surface=web', '--samples=1', '--no-profile', '--storage-series', '--decks',
        '--host=' + args.host, '--lease=' + args.lease, '--out=' + str(out)]
    if args.profile:
        argv.append('--disk-profile')
    print('DISK_REOPEN_SAMPLE', sample, flush=True)
    child = subprocess.run(argv)
    exits.append(child.returncode)
    (out / 'collector-exit.json').write_text(json.dumps({'returncode':child.returncode}))
    # A teardown failure is retained and consumes its scheduled sample.
    # Continue independent contexts; never retry or silently drop a cell.
raise SystemExit(1 if any(exits) else 0)
