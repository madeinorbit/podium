"""Memory and startup baseline for the data on device design (POD-7099).

Runs ON the measurement host, inside the checkout remote-lane prepared, while
remote-lane holds the host's lock for the whole call:

    LANE_LOCK_TTL=150m LANE_TIMEOUT=9000 remote-lane polaris <issue> run \\
      python3 apps/web/harness/data-on-device-baseline.py all --host=polaris --round=1

Steps (each is also a subcommand, so a long run can be split across calls):
  prepare  Chromium (and its libraries), podium-host, production web and phone
           builds, corpus cells h1a1/h10a1
  memory   one cold start per checkout, surface and cell; V8 heap and renderer RSS
  timing   --samples cold/warm first-Paint pairs per cell (startup-baseline.py)
  report   summary JSON and Markdown tables under .artifacts/7099/
  clean    delete generated corpora and the base checkout (small disks)

`--base=<sha>` adds a second checkout of that commit beside this one
(~/<this checkout>-base), and every step measures both, interleaved, so the
base and the candidate share the host's drift. Without it, only this checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import statistics
import subprocess
import importlib.util

import measure_hosts

HERE = Path(__file__).resolve().parent
CELLS = ['h1a1', 'h10a1']
SURFACES = ['web', 'phone']
PRODUCT = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages']
HARNESS = ['apps/web/harness', 'apps/mobile/harness']
# Chromium's Ubuntu 24.04 libraries that the vega VM lacks (no sudo there):
# fetched with `apt-get download` and unpacked into the user's cache, never
# installed system-wide. cold-start.mjs puts DEPS_LIB on Chromium's library path.
DEPS = Path.home() / '.cache/podium-chromium-deps'
DEPS_LIB = DEPS / 'root/usr/lib/x86_64-linux-gnu'
DEB_PACKAGES = ['libgbm1', 'libasound2t64', 'libatk1.0-0t64', 'libatk-bridge2.0-0t64', 'libatspi2.0-0t64',
                'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxrandr2', 'libxfixes3', 'libdrm2',
                'libxshmfence1', 'libwayland-server0', 'libxi6', 'libxtst6', 'fonts-liberation']


def sh(command, cwd, **kwargs):
    print(f'+ ({cwd.name}) {command}', flush=True)
    return subprocess.run(['bash', '-c', measure_hosts.TOOLCHAIN + command], cwd=cwd, check=True, **kwargs)


def git(cwd, *argv):
    return subprocess.run(['git', *argv], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def checkouts(args):
    here = Path.cwd()
    if not here.name.startswith('podium-test-') or here.parent != Path.home():
        raise SystemExit('Run inside the issue checkout remote-lane made (~/podium-test-<issue>)')
    found = []
    if args.base:
        base = here.parent / f'{here.name}-base'
        found.append(base)
    found.append(here)
    return found


def missing_libraries(chrome):
    env = {**os.environ, 'LD_LIBRARY_PATH': str(DEPS_LIB)} if DEPS_LIB.is_dir() else {
        key: value for key, value in os.environ.items() if key != 'LD_LIBRARY_PATH'}
    out = subprocess.run(['ldd', str(chrome)], env=env, capture_output=True, text=True).stdout
    return sorted({line.split()[0] for line in out.splitlines() if 'not found' in line})


def chromium_libraries():
    chrome = max(Path.home().glob('.cache/ms-playwright/chromium-*/chrome-linux64/chrome'), key=lambda p: p.stat().st_mtime)
    if not missing_libraries(chrome):
        print(f'{chrome}: every library resolves', flush=True)
        return
    debs = DEPS / 'debs'
    debs.mkdir(parents=True, exist_ok=True)
    subprocess.run(['apt-get', 'download', *DEB_PACKAGES], cwd=debs, check=True)
    for deb in sorted(debs.glob('*.deb')):
        subprocess.run(['dpkg', '-x', str(deb), str(DEPS / 'root')], check=True)
    fonts = Path.home() / '.local/share/fonts'
    fonts.mkdir(parents=True, exist_ok=True)
    for font in (DEPS / 'root/usr/share/fonts').rglob('*.ttf'):
        shutil.copy2(font, fonts / font.name)
    still = missing_libraries(chrome)
    if still:
        raise SystemExit(f'Chromium still lacks {still}; add their packages to DEB_PACKAGES')
    print(f'{chrome}: libraries resolve with {DEPS_LIB}', flush=True)


def prepare(args):
    here = Path.cwd()
    paths = checkouts(args)
    if args.base:
        base = paths[0]
        if not base.exists():
            sh(f'git worktree add --detach {shlex.quote(str(base))} {shlex.quote(args.base)}', here)
        sh(f'git checkout -q --detach {shlex.quote(args.base)}', base)
        # Both arms run the SAME collector: the candidate's harness files over the
        # base's product tree. The product directories stay exactly the base's.
        candidate = git(here, 'rev-parse', 'HEAD')
        sh(f'git checkout {candidate} -- {" ".join(HARNESS)}', base)
        sh('bun install --frozen-lockfile >/dev/null', base)
    # Playwright's own Chromium (the version this lockfile pins), new headless mode.
    sh('bun x playwright install chromium', here)
    chromium_libraries()
    for path in paths:
        # The harness daemon spawns sessions through podium-host, which a source
        # checkout builds with cargo into ~/.cache/podium/podium-host-src on first
        # use. The lane PATH has no cargo (vega keeps it in ~/.cargo/bin), so build
        # it here, before any capture, instead of failing every spawn.
        sh('PATH="$PATH:$HOME/.cargo/bin" bun --conditions=@podium/source -e '
           + shlex.quote('const { resolveHostBin } = await import("./packages/pty/src/host-bin.ts"); '
                         'const bin = resolveHostBin(); if (!bin) process.exit(1); console.log("podium-host", bin)'), path)
    for path in paths:
        head = git(path, 'rev-parse', '--short=7', 'HEAD')
        for app in ['web', 'mobile']:
            stamp = path / f'apps/{app}/dist/podium-build.json'
            if stamp.exists() and json.loads(stamp.read_text()).get('sourceSha') == head:
                print(f'{path.name}: apps/{app} production build already at {head}', flush=True)
                continue
            sh(f'bun run --cwd apps/{app} build', path)
        for cell in CELLS:
            if (path / f'.artifacts/old-vs-new/rows-{cell}.json').exists():
                continue
            sh(f'bun --conditions=@podium/source apps/web/harness/old-vs-new-corpus.mjs --cell={cell}', path)


def memory_round(args):
    return args.memory_round or args.round


def memory(args):
    host = measure_hosts.HOSTS[args.host]
    for cell in (args.cells.split(',') if args.cells else CELLS):
        for surface in (args.surfaces.split(',') if args.surfaces else SURFACES):
            for path in checkouts(args):
                relative = f'.artifacts/old-vs-new/memory-{cell}-{surface}-{cell}-r{memory_round(args)}'
                if (path / relative / 'run.json').exists():
                    raise SystemExit(f'{path.name}/{relative} exists; use a fresh --round')
                (path / relative).mkdir(parents=True)
                (path / relative / 'lease.json').write_text(json.dumps({
                    'name': host[1], 'host': host[0], 'heldBy': 'remote-lane (whole call)'}) + '\n')
                argv = ['bun', '--conditions=@podium/source', 'apps/web/harness/cold-start.mjs', '--external-lease',
                        '--mode=memory', f'--arm={cell}', f'--surface={surface}', f'--cell={cell}',
                        f'--round={memory_round(args)}', '--samples=1', '--port=19671', f'--out={relative}',
                        f'--host={host[0]}', f'--lease={host[1]}', *(['--heap-timeline'] if args.heap_timeline else [])]
                sh(shlex.join(['python3', 'apps/web/harness/flatblock-budget.py', '--census',
                               f'--min-available-gib={args.min_available_gib}',
                               f'--log={relative}/collector.log', '--', *argv]), path)


def timing(args):
    names = ','.join(path.name for path in checkouts(args))
    for surface in ([args.surface] if args.surface else SURFACES):
        sh(shlex.join(['python3', str(HERE / 'startup-baseline.py'), f'--host={args.host}', '--local', '--lock-held',
                       f'--checkout={names}', f'--cells={",".join(CELLS)}', f'--surface={surface}',
                       f'--samples={args.samples}', f'--round={args.round}',
                       f'--min-available-gib={args.min_available_gib}']), Path.cwd())


def product_tree(path, ref):
    listing = subprocess.run(['git', 'ls-tree', '-r', ref, '--', *PRODUCT], cwd=path, check=True, capture_output=True).stdout
    return hashlib.sha256(listing).hexdigest()


def admitted_timing(ledger, guard):
    """Per capture, the guard's checks (one cold/warm pair each). Admitted pairs
    give the medians; a rejected pair is kept with its reason and values, never
    folded in. One cohort, host, lock, corpus, Chromium and collector per arm."""
    data = json.loads(ledger.read_text())
    if data['status'] != 'complete':
        raise SystemExit(f'{ledger}: the round is {data["status"]}, not complete')
    arms = {}
    for key, paths in data['outputs'].items():
        cell = key.rsplit('/', 1)[-1]
        admitted, rejected, provenance = [], [], set()
        for path in paths:
            run = json.loads(Path(path).expanduser().read_text())
            pair = [row for row in run['actions'] if not row.get('profiled')]
            values = {row['action']: row['inputToPaintMs'] for row in pair}
            entry = {'run': path, 'sha': run['sha'], 'productTreeSha256': run['productTreeSha256'],
                     'coldMs': values.get('app-cold-start'), 'warmMs': values.get('app-warm-start'),
                     'startedAt': run['startedAt'], 'loadStart': run['loadStart'], 'build': run.get('build')}
            try:
                _, one = guard.cold_samples([path], min_samples=1)
                if [row['action'] for row in pair] != ['app-cold-start', 'app-warm-start']:
                    raise ValueError('not one cold/warm pair')
                if one[3] != data['cohort'] or one[5] != data['surface'] or one[7] != cell:
                    raise ValueError('controller and capture provenance differ')
                provenance.add(one)
                admitted.append(entry)
            except ValueError as error:
                entry['rejected'] = str(error).split(': ', 1)[-1]
                entry['errors'] = [e for e in run.get('errors', []) if not guard.fixture_noise(e, run['surface'])]
                rejected.append(entry)
        if len(provenance) > 1:
            raise SystemExit(f'{key}: admitted captures differ in provenance')

        def spread(values):
            return {'samplesMs': values, 'medianMs': statistics.median(values), 'minMs': min(values), 'maxMs': max(values)} if values else None
        (one,) = provenance or {(None,) * 10}
        arms[key] = {'cell': cell, 'admitted': admitted, 'rejected': rejected,
                     'cold': spread([e['coldMs'] for e in admitted]), 'warm': spread([e['warmMs'] for e in admitted]),
                     'semanticSha256': one[0], 'browser': one[1], 'collectorSha256': one[4], 'host': one[8], 'lock': one[9]}
    return {'surface': data['surface'], 'cohort': data['cohort'], 'host': data.get('host'), 'arms': arms}


def report(args):
    spec = importlib.util.spec_from_file_location('cold_start_guard', HERE / 'cold-start-guard.py')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    out = Path('.artifacts/7099')
    out.mkdir(parents=True, exist_ok=True)
    result = {'host': measure_hosts.HOSTS[args.host][0], 'round': args.round, 'memoryRound': memory_round(args),
              'productBase': None, 'memory': [], 'timing': {}}
    if args.product_base:
        result['productBase'] = {'sha': git(Path.cwd(), 'rev-parse', args.product_base),
                                 'productTreeSha256': product_tree(Path.cwd(), args.product_base)}
    for path in checkouts(args):
        for cell in CELLS:
            for surface in SURFACES:
                run_path = path / f'.artifacts/old-vs-new/memory-{cell}-{surface}-{cell}-r{memory_round(args)}/run.json'
                if not run_path.exists():
                    continue
                run = json.loads(run_path.read_text())
                mem = run.get('memory') or {}
                result['memory'].append({
                    'checkout': path.name, 'cell': cell, 'surface': surface, 'status': run['status'],
                    'failure': run.get('failure'), 'sha': run['sha'], 'productTreeSha256': run['productTreeSha256'],
                    'browser': run.get('browser'), 'population': run.get('population'), 'build': run.get('build'),
                    'browserLibraryPath': run.get('browserLibraryPath'),
                    'heapUsedAfterGcMiB': mem.get('heapUsedAfterGcBytes', 0) / 1048576,
                    'heapUsedBeforeGcMiB': mem.get('heapUsedBeforeGcBytes', 0) / 1048576,
                    'heapTotalAfterGcMiB': mem.get('heapTotalAfterGcBytes', 0) / 1048576,
                    'rendererRssMiB': (mem.get('appRendererRssKiB') or 0) / 1024,
                    'rendererPssMiB': (mem.get('appRendererPssKiB') or 0) / 1024,
                    'rendererPeakRssMiB': (mem.get('appRendererHwmKiB') or 0) / 1024,
                    'browserTreeRssMiB': mem.get('browserTreeRssKiB', 0) / 1024,
                    'renderers': sum(1 for p in mem.get('processes', []) if p['type'] == 'renderer'),
                    'measuredAt': mem.get('measuredAt'), 'loadStart': run.get('loadStart'), 'cpu': run.get('cpu'),
                    'cores': run.get('cores'),
                })
    for surface in SURFACES:
        ledger = Path(f'.artifacts/startup-baseline/{surface}-r{args.round}.json')
        if ledger.exists():
            result['timing'][surface] = admitted_timing(ledger, guard)
    (out / f'summary-r{args.round}.json').write_text(json.dumps(result, indent=2) + '\n')
    trees = {row['productTreeSha256'] for row in result['memory']} | {
        e['productTreeSha256'] for d in result['timing'].values() for a in d['arms'].values() for e in a['admitted'] + a['rejected']}
    shas = {row['sha'] for row in result['memory']} | {
        e['sha'] for d in result['timing'].values() for a in d['arms'].values() for e in a['admitted'] + a['rejected']}
    lines = [f'Host `{result["host"]}`; timing round {args.round}, memory round {memory_round(args)}.',
             f'Measured SHAs: {", ".join(f"`{x}`" for x in sorted(shas))}; product trees: {", ".join(f"`{x[:12]}`" for x in sorted(trees))}.']
    if result['productBase']:
        base = result['productBase']
        lines.append(f'Product base `{base["sha"][:10]}` tree `{base["productTreeSha256"][:12]}`'
                     f' ({"equal to" if base["productTreeSha256"] in trees else "different from"} a measured tree).')
    lines += ['', '| Checkout | Surface | Cell | Heap after GC (MiB) | Heap before GC (MiB) | Renderer RSS (MiB) | Renderer PSS (MiB) | Renderer peak RSS (MiB) | Browser RSS (MiB) |',
              '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for row in result['memory']:
        if row['status'] != 'complete':
            lines.append(f'| `{row["checkout"]}` | {row["surface"]} | `{row["cell"]}` | failed: {row["failure"]} | | | | | |')
            continue
        lines.append(f'| `{row["checkout"]}` | {row["surface"]} | `{row["cell"]}` | {row["heapUsedAfterGcMiB"]:.1f} | {row["heapUsedBeforeGcMiB"]:.1f} | '
                     f'{row["rendererRssMiB"]:.1f} | {row["rendererPssMiB"]:.1f} | {row["rendererPeakRssMiB"]:.1f} | {row["browserTreeRssMiB"]:.1f} |')
    lines += ['', '| Surface | Arm | Admitted pairs | Cold paint s, median (min–max) | Warm paint s, median (min–max) | Cold samples s | Warm samples s |',
              '| --- | --- | ---: | ---: | ---: | --- | --- |']
    fmt = lambda s: f'{s["medianMs"] / 1000:.2f} ({s["minMs"] / 1000:.2f}–{s["maxMs"] / 1000:.2f})' if s else '–'
    seconds = lambda values: ', '.join(f'{v / 1000:.2f}' for v in values)
    rejected = []
    for surface, data in result['timing'].items():
        for key, arm in data['arms'].items():
            n = len(arm['admitted'])
            lines.append(f'| {surface} | `{key}` | {n} of {n + len(arm["rejected"])} | {fmt(arm["cold"])} | {fmt(arm["warm"])} | '
                         f'{seconds(arm["cold"]["samplesMs"]) if arm["cold"] else ""} | {seconds(arm["warm"]["samplesMs"]) if arm["warm"] else ""} |')
            rejected += [(surface, key, e) for e in arm['rejected']]
    if rejected:
        lines += ['', 'Rejected pairs (not in the medians):', '']
        for surface, key, e in rejected:
            cold = f'{e["coldMs"] / 1000:.2f}' if e['coldMs'] else '–'
            warm = f'{e["warmMs"] / 1000:.2f}' if e['warmMs'] else '–'
            lines.append(f'- {surface} `{key}` `{e["run"]}`: cold {cold} s, warm {warm} s; {e["rejected"]}. '
                         + 'Errors: ' + ' | '.join(x[:160] for x in e['errors']))
    browsers = sorted({row['browser'] for row in result['memory'] if row.get('browser')}
                      | {a['browser'] for d in result['timing'].values() for a in d['arms'].values() if a['browser']})
    lines += ['', f'Chromium: {", ".join(browsers) or "unknown"}.']
    text = '\n'.join(lines) + '\n'
    (out / f'summary-r{args.round}.md').write_text(text)
    print(text, flush=True)
    print('SUMMARY_JSON ' + json.dumps(result), flush=True)


def clean(args):
    for path in checkouts(args):
        for cell in CELLS:
            for name in [f'corpus-{cell}.json', f'rows-{cell}.json']:
                target = path / '.artifacts/old-vs-new' / name
                if target.exists():
                    target.unlink()
                    print(f'removed {path.name}/{target.relative_to(path)}', flush=True)
    if args.base:
        base = checkouts(args)[0]
        if base.exists():
            sh(f'git worktree remove --force {shlex.quote(str(base))}', Path.cwd())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('step', choices=['all', 'prepare', 'memory', 'timing', 'report', 'clean'])
    parser.add_argument('--host', required=True, choices=['vega', 'polaris'], help='the host remote-lane runs this on')
    parser.add_argument('--round', type=int, default=1, help='fresh number per measurement; captures are never overwritten')
    parser.add_argument('--base', default='', help='also measure this commit in ~/<checkout>-base (the AFTER run)')
    parser.add_argument('--product-base', default='', help='report whether each checkout\'s product tree equals this commit\'s')
    parser.add_argument('--memory-round', type=int, default=0, help='memory captures use this round (default: --round)')
    parser.add_argument('--samples', type=int, default=3, help='cold/warm pairs per cell and surface')
    parser.add_argument('--surface', default='', choices=['', *SURFACES], help='timing: one surface only')
    parser.add_argument('--min-available-gib', type=float, default=5)
    parser.add_argument('--cells', default='', help='memory: comma-separated cells (default: every cell)')
    parser.add_argument('--surfaces', default='', help='memory: comma-separated surfaces (default: both)')
    parser.add_argument('--heap-timeline', action='store_true',
                        help='memory: heap and RSS timeline plus one allocation profile per phase (POD-7115)')
    args = parser.parse_args()
    steps = {'prepare': prepare, 'memory': memory, 'timing': timing, 'report': report, 'clean': clean}
    for step in (['prepare', 'memory', 'timing', 'report'] if args.step == 'all' else [args.step]):
        print(f'== {step}', flush=True)
        steps[step](args)


if __name__ == '__main__':
    main()
