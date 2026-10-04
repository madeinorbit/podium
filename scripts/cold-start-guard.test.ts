import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const guard = fileURLToPath(new URL('../apps/web/harness/cold-start-guard.py', import.meta.url))
const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function run(ms: number, patch: Record<string, unknown> = {}) {
  return {
    status: 'complete', host: 'flatblock', surface: 'web', scale: 1,
    startupBoundary: 'sidebar-issue-row',
    semanticSha256: 'same-semantic-corpus', browser: '153.0.8010.12',
    httpCache: 'disabled by bootstrap request routing', lease: { name: 'bench:flatblock', cohort: 'paired-fixture' },
    paired: true, harnessSha256: 'same-collector', sha: '0123456789abcdef',
    build: { sourceSha: '0123456', bundleVersion: 'fixture-bundle' },
    population: { issueProjection: 4_867, session: 4_304 },
    corpus: { syntheticIssues: 4_867, syntheticSessions: 4_304 }, errors: [],
    actions: Array.from({ length: 8 }, (_, index) => ({
      action: 'app-cold-start', startedAt: `2026-10-04T12:${String(index).padStart(2, '0')}:00.000Z`,
      profiled: false, inputToPaintMs: ms,
      population: { issueProjection: 4_867, session: 4_304 },
    })),
    ...patch,
  }
}

function compare(old: ReturnType<typeof run>, candidate: ReturnType<typeof run>, excluded = false) {
  const directory = mkdtempSync(join(tmpdir(), 'pod-5513-guard-'))
  directories.push(directory)
  const oldPath = join(directory, 'old.json'), candidatePath = join(directory, 'candidate.json')
  writeFileSync(oldPath, JSON.stringify(old)); writeFileSync(candidatePath, JSON.stringify(candidate))
  if (excluded) writeFileSync(join(directory, 'EXCLUDED.json'), JSON.stringify({ reason: 'companion build overlapped' }))
  return spawnSync('python3', [guard, '--old', oldPath, '--candidate', candidatePath], { encoding: 'utf8' })
}

describe('cold startup admission', () => {
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
      { status: 'failed' }, { variants: ['reader'] }, { diagnostic: true },
      { population: { issueProjection: 100, session: 4_304 } },
      { semanticSha256: 'different-corpus' }, { browser: 'different-browser' },
      { lease: { name: 'meter:flatblock' } }, { actions: run(2_400).actions.slice(0, 7) },
      { paired: false }, { lease: { name: 'bench:flatblock', cohort: 'other-run' } },
      { harnessSha256: 'different-collector' }, { build: { sourceSha: '7654321', bundleVersion: 'stale' } },
      { actions: run(2_400).actions.map(row => ({ ...row, population: {} })) },
      { startupBoundary: 'header-label' },
    ]) expect(compare(run(2_500), run(2_400, patch)).status).not.toBe(0)
  })

  it('rejects application errors and cold RPC warnings while retaining explicit fixture noise', () => {
    expect(compare(run(2_500), run(2_400, { errors: ['TypeError: cannot build pool'] })).status).not.toBe(0)
    const warning = ' WARN  web:trpc trpc call could not be sent path=quota.summary error={} platform=test'
    expect(compare(run(2_500), run(2_400, { errors: ['warning: 12:00:01.000'+warning] })).status).not.toBe(0)
    expect(compare(run(2_500), run(2_400, { errors: ['warning: 12:00:10.000'+warning] })).status).toBe(0)
    expect(compare(run(2_500), run(2_400, { errors: ['warning: Service Worker registration blocked by Playwright'] })).status).toBe(0)
  })
})
