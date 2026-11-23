import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const guard = fileURLToPath(new URL('../apps/web/harness/cold-start-guard.py', import.meta.url))
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function run(ms: number, patch: Record<string, unknown> = {}) {
  return {
    status: 'complete',
    host: 'flatblock',
    surface: 'web',
    scale: 1,
    startupBoundary: 'sidebar-issue-row',
    semanticSha256: 'same-semantic-corpus',
    browser: '153.0.8010.12',
    httpCache: 'disabled by bootstrap request routing',
    lease: { name: 'bench:flatblock', cohort: 'paired-fixture' },
    paired: true,
    harnessSha256: 'same-collector',
    sha: '0123456789abcdef',
    build: { sourceSha: '0123456', bundleVersion: 'fixture-bundle' },
    population: { issueProjection: 4_867, session: 4_304 },
    corpus: { syntheticIssues: 4_867, syntheticSessions: 4_304 },
    errors: [],
    actions: Array.from({ length: 8 }, (_, index) => ({
      action: 'app-cold-start',
      startedAt: `2026-10-04T12:${String(index).padStart(2, '0')}:00.000Z`,
      profiled: false,
      inputToPaintMs: ms,
      population: { issueProjection: 4_867, session: 4_304 },
    })),
    ...patch,
  }
}

function compare(old: ReturnType<typeof run>, candidate: ReturnType<typeof run>, excluded = false) {
  const directory = mkdtempSync(join(tmpdir(), 'pod-5513-guard-'))
  directories.push(directory)
  const oldPath = join(directory, 'old.json'),
    candidatePath = join(directory, 'candidate.json')
  writeFileSync(oldPath, JSON.stringify(old))
  writeFileSync(candidatePath, JSON.stringify(candidate))
  if (excluded)
    writeFileSync(
      join(directory, 'EXCLUDED.json'),
      JSON.stringify({ reason: 'companion build overlapped' }),
    )
  return spawnSync('python3', [guard, '--old', oldPath, '--candidate', candidatePath], {
    encoding: 'utf8',
  })
}

describe('cold startup admission', () => {
  it('adds a privately configured measurement VM without rerouting a recorded host', () => {
    const directory = fileURLToPath(new URL('../apps/web/harness/', import.meta.url))
    const probe = `import argparse, sys
sys.path.insert(0, sys.argv[1])
import measure_hosts
parser = argparse.ArgumentParser()
measure_hosts.add_arguments(parser)
args = parser.parse_args(['--host=fixture-vm', '--local', '--lock-held'])
host = measure_hosts.resolve(args)
assert (host.alias, host.lock, host.local, host.held) == ('fixture-alias', 'test:fixture-vm', True, True)
`
    const configured = (mapping: Record<string, string[]>) =>
      spawnSync('python3', ['-c', probe, directory], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PODIUM_MEASUREMENT_HOSTS: JSON.stringify(mapping),
        },
      })
    const added = configured({ 'fixture-vm': ['fixture-alias', 'test:fixture-vm'] })
    expect(added.status, added.stderr).toBe(0)
    const rerouted = configured({ vega: ['fixture-alias', 'test:fixture-vm'] })
    expect(rerouted.status).not.toBe(0)
    expect(rerouted.stderr).toContain('Additional measurement hosts')
    expect(configured({ 'fixture-vm': ['fixture-alias', 'merge:main'] }).status).not.toBe(0)
  })

  it('recovers a completed pair only for its original plan and cohort', () => {
    const controller = fileURLToPath(
      new URL('../apps/web/harness/startup-baseline.py', import.meta.url),
    )
    const fixture = run(2_400, {
      mode: 'timing',
      cell: 'h1a1',
      endedAt: '2026-11-18T12:00:00Z',
      actions: [run(2_400).actions[0], { ...run(2_400).actions[0], action: 'app-warm-start' }],
    })
    const result = spawnSync(
      'python3',
      [
        '-c',
        `import copy, importlib.util, json, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location('controller', sys.argv[1])
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
run = json.loads(sys.argv[2])
host = SimpleNamespace(alias='flatblock', lock='bench:flatblock')
args = ({'cell': 'h1a1'}, 'paired-fixture', host, 'web')
assert controller.completed_pair(run, *args) is run
for patch in [{'status': 'running'}, {'endedAt': None}, {'cell': 'h10a1'},
              {'surface': 'phone'}, {'host': 'other-host'},
              {'lease': {'cohort': 'other-run', 'name': host.lock}},
              {'lease': {'cohort': 'paired-fixture', 'name': 'meter:flatblock'}},
              {'actions': run['actions'][:1]},
              {'actions': [dict(a, profiled=True) for a in run['actions']]},
              {'actions': [dict(a, inputToPaintMs=0) for a in run['actions']]}]:
    invalid = copy.deepcopy(run)
    invalid.update(patch)
    try:
        controller.completed_pair(invalid, *args)
    except ValueError:
        continue
    raise AssertionError(f'recovered mismatched capture: {patch}')
`,
        controller,
        JSON.stringify(fixture),
      ],
      { encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
  })

  it('requires every policy-held session and every issue stub before a bounded reload', () => {
    const policy = run(2_400, {
      policyRows: { clientType: 'phone', sessions: 300 },
      population: { issueProjection: 4_867, session: 300 },
      actions: run(2_400).actions.map((row) => ({
        ...row,
        population: { issueProjection: 4_867, session: 300 },
      })),
    })
    expect(compare(run(2_500), policy).status).toBe(0)
    expect(
      compare(run(2_500), { ...policy, population: { issueProjection: 4_867, session: 299 } })
        .status,
    ).not.toBe(0)
    expect(
      compare(run(2_500), { ...policy, population: { issueProjection: 4_866, session: 300 } })
        .status,
    ).not.toBe(0)
    expect(
      compare(run(2_500), {
        ...policy,
        actions: policy.actions.map((row) => ({
          ...row,
          population: { issueProjection: 4_867, session: 299 },
        })),
      }).status,
    ).not.toBe(0)
  })

  it('refuses a capture explicitly excluded for overlapping build work', () => {
    const result = compare(run(2_500), run(2_400), true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('explicitly excluded')
  })
  it('requires both the matched OLD budget and the original 2.5 second ceiling', () => {
    expect(compare(run(2_500), run(2_400)).status).toBe(0)
    expect(compare(run(2_300), run(2_400)).status).toBe(1)
    expect(compare(run(3_100), run(2_600)).status).toBe(1)
  })

  it('does not let a fast profile sample hide an actual regression', () => {
    const candidate = run(3_300)
    candidate.actions.push({ ...candidate.actions[0]!, profiled: true, inputToPaintMs: 100 })
    const result = compare(run(2_500), candidate)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('COLD START GUARD RED')
    expect(result.stdout).toContain('"candidateSamples": 8')
  })

  it('refuses incomplete, ablated, underpopulated and mismatched captures', () => {
    for (const patch of [
      { status: 'failed' },
      { variants: ['reader'] },
      { diagnostic: true },
      { population: { issueProjection: 100, session: 4_304 } },
      { semanticSha256: 'different-corpus' },
      { browser: 'different-browser' },
      { lease: { name: 'meter:flatblock' } },
      { actions: run(2_400).actions.slice(0, 7) },
      { paired: false },
      { lease: { name: 'bench:flatblock', cohort: 'other-run' } },
      { harnessSha256: 'different-collector' },
      { build: { sourceSha: '7654321', bundleVersion: 'stale' } },
      { actions: run(2_400).actions.map((row) => ({ ...row, population: {} })) },
      { startupBoundary: 'header-label' },
      { host: 'other-host' },
      { host: '' },
    ])
      expect(compare(run(2_500), run(2_400, patch)).status).not.toBe(0)
  })

  it('admits a matched phone or two-axis cell pair and refuses a mismatched one (POD-5594)', () => {
    const phone = { surface: 'phone', startupBoundary: 'phone-issue-row', cell: 'h10a1' }
    expect(compare(run(2_500, phone), run(2_400, phone)).status).toBe(0)
    expect(compare(run(2_500, phone), run(2_400, { ...phone, cell: 'h1a1' })).status).not.toBe(0)
    expect(compare(run(2_500, phone), run(2_400, { ...phone, surface: 'web' })).status).not.toBe(0)
    expect(compare(run(2_500), run(2_400, { cell: 'h10a1' })).status).not.toBe(0)
    expect(
      compare(run(2_500, phone), run(2_400, { ...phone, startupBoundary: 'sidebar-issue-row' }))
        .status,
    ).not.toBe(0)
  })

  it('admits an agent VM capture under its remote-lane lock, never mixed with another host (POD-7099)', () => {
    const vm = {
      host: 'polaris-agents',
      lease: { name: 'test:polaris-agents', cohort: 'paired-fixture' },
    }
    expect(compare(run(2_500, vm), run(2_400, vm)).status).toBe(0)
    expect(
      compare(
        run(2_500, vm),
        run(2_400, {
          ...vm,
          host: 'vega-agents',
          lease: { name: 'test:vega-agents', cohort: 'paired-fixture' },
        }),
      ).status,
    ).not.toBe(0)
    expect(
      compare(
        run(2_500, vm),
        run(2_400, { ...vm, lease: { name: 'meter:polaris-agents', cohort: 'paired-fixture' } }),
      ).status,
    ).not.toBe(0)
  })

  it('rejects application errors and cold RPC warnings while retaining explicit fixture noise', () => {
    expect(
      compare(run(2_500), run(2_400, { errors: ['TypeError: cannot build pool'] })).status,
    ).not.toBe(0)
    const warning =
      ' WARN  web:trpc trpc call could not be sent path=quota.summary error={} platform=test'
    expect(
      compare(run(2_500), run(2_400, { errors: ['warning: 12:00:01.000' + warning] })).status,
    ).not.toBe(0)
    expect(
      compare(run(2_500), run(2_400, { errors: ['warning: 12:00:10.000' + warning] })).status,
    ).toBe(0)
    expect(
      compare(
        run(2_500),
        run(2_400, { errors: ['warning: Service Worker registration blocked by Playwright'] }),
      ).status,
    ).toBe(0)
  })

  it('retains only the exact native-animation fallback warning on the phone web surface', () => {
    const phone = { surface: 'phone', startupBoundary: 'phone-issue-row' }
    const warning =
      'warning: Animated: `useNativeDriver` is not supported because the native animated module is missing. Falling back to JS-based animation. To resolve this, add `RCTAnimation` module to this app, or remove `useNativeDriver`. Make sure to run `bundle exec pod install` first. Read more about autolinking: https://github.com/react-native-community/cli/blob/master/docs/autolinking.md'
    expect(compare(run(2_500, phone), run(2_400, { ...phone, errors: [warning] })).status).toBe(0)
    expect(compare(run(2_500), run(2_400, { errors: [warning] })).status).not.toBe(0)
    expect(
      compare(run(2_500, phone), run(2_400, { ...phone, errors: [warning + ' changed'] })).status,
    ).not.toBe(0)
    expect(
      compare(run(2_500, phone), run(2_400, { ...phone, errors: ['TypeError: cannot build pool'] }))
        .status,
    ).not.toBe(0)
  })
})
