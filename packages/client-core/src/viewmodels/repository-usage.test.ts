import { afterEach, describe, expect, it } from 'vitest'
import { readRuntimeStoreStats, recordSliceDerivation, storeStats } from '../perf/store-stats'
import { createRepositoryUsageSelector, indexedRepoUsageAt } from './repository-usage'
import { repoUsageAt } from './slices/machines/facts'

type Session = Parameters<ReturnType<typeof createRepositoryUsageSelector>>[0][number]
const session = (cwd: string, lastActiveAt = '2026-09-18T12:00:00Z'): Session => ({
  cwd, lastActiveAt, agentKind: 'claude-code',
})
const repo = (path: string, worktrees: string[] = []) => ({
  path, worktrees: worktrees.map((path) => ({ path })),
})
afterEach(() => { storeStats.enable(false); storeStats.reset() })

describe('repository usage', () => {
  it('A/B: three idle frames retain MRU values while eliminating repeated world scans', () => {
    const repos = Array.from({ length: 500 }, (_, i) => repo(`/src/repo-${i}`))
    const initial = Array.from({ length: 4304 }, (_, i) =>
      session(`/src/repo-${i % 500}/src`, new Date(1_700_000_000_000 + i * 1000).toISOString()))
    const results = []
    const orders: number[][][] = []
    for (const legacy of [true, false]) {
      const select = createRepositoryUsageSelector()
      let visits = 0
      const tracked = (rows: Session[]) => {
        rows[Symbol.iterator] = function* (): Generator<Session, undefined, unknown> {
          for (let i = 0; i < this.length; i++) { visits++; yield this[i]! }
        }
        return rows
      }
      const derive = (rows: Session[]) => {
        if (legacy) {
          recordSliceDerivation(select, 'repositoryUsage.indexBuild')
          return repos.map((r) => repoUsageAt(r, rows))
        }
        const index = select(rows)
        return repos.map((r) => indexedRepoUsageAt(r, index))
      }
      derive(initial)
      storeStats.reset(); storeStats.enable()
      const frames = []
      for (let frame = 0; frame < 3; frame++) {
        // New entities and array, but only immaterial agent status/title changed.
        const rows = tracked(initial.map((s) => ({ ...s, title: `frame-${frame}`, status: 'running' })))
        frames.push(derive(rows))
      }
      orders.push(frames)
      const counts = readRuntimeStoreStats(select)!
      results.push({
        legacy, sessionVisits: visits,
        materialScans: counts.slices['repositoryUsage.materialScan'] ?? 0,
        indexBuilds: counts.slices['repositoryUsage.indexBuild'] ?? 0,
        choices: frames.map((values) => values.filter((v) => v > 0).length),
      })
    }
    // Counterfactual explicitly fails the optimized budget with the same instrument.
    expect(results[0]?.sessionVisits).toBeGreaterThan(3 * 4304)
    expect(results).toEqual([
      { legacy: true, sessionVisits: 6_456_000, materialScans: 0, indexBuilds: 3, choices: [500, 500, 500] },
      { legacy: false, sessionVisits: 12_912, materialScans: 3, indexBuilds: 0, choices: [500, 500, 500] },
    ])
    expect(orders[1]).toEqual(orders[0])
    console.info('repository picker idle A/B (500 repos, 4304 sessions, 3 frames)', results)
  })

  it('invalidates only on material membership, cwd and timestamp changes', () => {
    storeStats.enable()
    const select = createRepositoryUsageSelector()
    const first = [session('/a')]
    const initial = select(first)
    expect(select(first)).toBe(initial)
    expect(select(first.map((s) => ({ ...s, title: 'new', archived: true, status: 'exited' })))).toBe(initial)
    // Changing between non-shell agent kinds does not change membership.
    expect(select([{ ...first[0]!, agentKind: 'codex' }])).toBe(initial)
    const moved = select([session('/b')])
    expect(moved).not.toBe(initial)
    expect(moved.get('/a')).toBeUndefined()
    const newer = select([session('/b', '2026-09-19T00:00:00Z')])
    expect(newer.get('/b')).toBe(Date.parse('2026-09-19T00:00:00Z'))
    const shell = select([{ ...session('/b'), agentKind: 'shell' }])
    expect(shell.size).toBe(0)
    expect(select([{ ...session('/ignored'), agentKind: 'shell' }])).toBe(shell)
    expect(select([session('/b')]).has('/b')).toBe(true)
    expect(select([]).size).toBe(0)
    expect(readRuntimeStoreStats(select)?.slices).toEqual({
      'repositoryUsage.materialScan': 9,
      'repositoryUsage.indexBuild': 6,
    })
  })

  it('matches literal containment for nested, linked, duplicate and unusual roots', () => {
    const sessions = [session('/a/src'), session('/ab', '2026-09-20'),
      session('/linked/sub', '2026-09-19'), session('/a//deep', '2026-09-21'),
      session('/', '2026-09-22'), session('relative/path', '2026-09-23'),
      session('/invalid', 'bad'), session('/negative', '1960-01-01')]
    const index = createRepositoryUsageSelector()(sessions)
    for (const r of [repo('/a'), repo('/a/'), repo('/a/src'), repo('/a', ['/linked']),
      repo('/'), repo(''), repo('relative'), repo('/invalid'), repo('/negative'), repo('/absent'), repo('/ab')]) {
      expect(indexedRepoUsageAt(r, index), r.path).toBe(repoUsageAt(r, sessions))
    }
  })

  it('preserves MRU changes, removal of maxima, shell exclusion and independent scopes', () => {
    const select = createRepositoryUsageSelector()
    const repos = [repo('/a', ['/linked']), repo('/b')]
    const rows = [session('/a', '2026-09-16'), session('/linked', '2026-09-18'), session('/b', '2026-09-17')]
    const order = (sessions: Session[]) => {
      const index = select(sessions)
      const sorted = [...repos].sort((a, b) => indexedRepoUsageAt(b, index) - indexedRepoUsageAt(a, index))
      expect(sorted).toEqual([...repos].sort((a, b) => repoUsageAt(b, sessions.filter((s) => s.agentKind !== 'shell')) - repoUsageAt(a, sessions.filter((s) => s.agentKind !== 'shell'))))
      return sorted.map((r) => r.path)
    }
    expect(order(rows)).toEqual(['/a', '/b'])
    expect(order([rows[0]!, rows[2]!])).toEqual(['/b', '/a'])
    expect(order([...rows, session('/b', '2026-09-20')])).toEqual(['/b', '/a'])
    expect(order([...rows, { ...session('/b', '2026-09-20'), agentKind: 'shell' }])).toEqual(['/a', '/b'])
    expect(createRepositoryUsageSelector()([]).size).toBe(0)
    expect(select([]).size).toBe(0)
  })
})
