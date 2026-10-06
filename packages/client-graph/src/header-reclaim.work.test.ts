import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../../../tests/worklist/harness/src/mobx-trap'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { headerEntities } from './header-entities'
import type { HeaderRows } from './header-schema'
import { headerView } from './header-views'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

installMobxWarnTrap({ errors: true })
const DAY = 86_400_000
const NOW = Date.parse('2026-10-05T12:00:00Z')
const stamp = (at: number) => new Date(at).toISOString()
const issue = (id: string, path: string, patch: object = {}): RowRecord => ({
  kind: 'issue', id, value: {
    id, seq: 1, title: id, repoPath: '/repo', repoId: 'repo', worktreePath: path,
    machineId: 'm1', stage: 'done', closedAt: stamp(NOW - 2 * DAY),
    createdAt: stamp(NOW - 3 * DAY), updatedAt: stamp(NOW), description: '',
    deps: [], labels: [], archived: false, deletedAt: null, ...patch,
  },
}) as RowRecord
const session = (id: string, cwd: string): RowRecord => ({
  kind: 'session', id, value: {
    sessionId: id, cwd, machineId: 'm1', status: 'live', archived: false,
    lastActiveAt: stamp(NOW), agentKind: 'shell',
  },
}) as RowRecord

// The coordinator deferred the aggregate architecture to a separate issue.
// Record its current cost alongside correctness; this lane only fixes chrome.
it('records reclaim candidate and occupied-path work at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    const count = 128 * scale
    pool.apply({ type: 'replace', rows: [
      ...Array.from({ length: count }, (_, at) => issue(`old-${at}`, `/old/${at}`)),
      ...Array.from({ length: count }, (_, at) => session(`other-${at}`, `/occupied/${at}/src`)),
      issue('target', '/target'),
      issue('future', '/future', { closedAt: stamp(NOW - DAY + 1000) }),
    ] })
    const metric = { machineId: 'm1', hostname: 'm1', sampledAt: stamp(NOW) } as HeaderRows['hostMetric']
    headerEntities(pool).apply([{ kind: 'hostMetric', id: 'm1', value: metric }])
    let value: Record<string, number> = {}
    const stop = autorun(() => { value = headerView(pool).reclaimCounts(1) })
    const row = vi.spyOn(pool, 'row')
    const measure = async (name: string, action: () => void) => {
      row.mockClear()
      const { work } = await measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
      return { rows: work.rows, derivations: work.derivations, elements: work.elements,
        visits: work.visits, candidates: row.mock.calls.filter(([entity, , mode]) =>
          entity === 'issue' && mode === 'summary').length }
    }
    try {
      expect(value).toEqual({ m1: count + 1 })
      const title = await measure('reclaim candidate title', () => pool.apply({ type: 'update',
        rows: [issue('old-0', '/old/0', { title: 'Changed' })] }))
      const occupied = await measure('reclaim path neighbor', () => pool.apply({ type: 'update',
        rows: [session('target-seat', '/target/src')] }))
      expect(value).toEqual({ m1: count })
      const quiet = await measure('reclaim quiet tick', () => pool.clock.advance(NOW + 999))
      const deadline = await measure('reclaim crossed deadline', () => pool.clock.advance(NOW + 1000))
      expect(value).toEqual({ m1: count + 1 })
      stop()
      const released = await measure('reclaim released demand', () => pool.apply({ type: 'update',
        rows: [issue('target', '/target', { machineId: 'm2' })] }))
      expect(released.candidates).toBe(0)
      samples.push({ scale, actions: { title, occupied, quiet, deadline, released } })
    } finally { stop(); row.mockRestore(); pool.dispose() }
  }
  const directory = resolve('tests/worklist/harness/browser/results')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'header-reclaim-work.json'), JSON.stringify(samples, null, 2) + '\n')
  console.info('[header reclaim work]', JSON.stringify(samples))
})
