import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { missionLegacyStats } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph/pool'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'

const client = (name: string) => readFileSync(resolve(import.meta.dirname, name), 'utf8')

describe('mobile performance boundaries', () => {
  it("keeps the web and native persistence engines out of each other's bundles", () => {
    const provider = client('MobileClientProvider.tsx')
    const web = client('mobile-entity-store.web.ts')
    const native = client('mobile-entity-store.native.ts')

    expect(provider).toContain("from './mobile-entity-store'")
    expect(provider).not.toMatch(
      /['"](?:expo-sqlite|@podium\/sync\/adapters\/(?:indexeddb|mobile-sqlite))['"]/,
    )

    expect(web).toContain('@podium/sync/adapters/indexeddb')
    expect(web).not.toMatch(/['"](?:expo-sqlite|@podium\/sync\/adapters\/mobile-sqlite)['"]/)

    expect(native).toMatch(/from ['"]expo-sqlite['"]/)
    expect(native).toContain('@podium/sync/adapters/mobile-sqlite')
    expect(native).not.toMatch(/['"]@podium\/sync\/adapters\/indexeddb['"]/)
  })

  it('keeps phone progress on the shared worklist companions without legacy slice derivations', () => {
    const workScreen = readFileSync(
      resolve(import.meta.dirname, '../screens/WorkScreen.tsx'),
      'utf8',
    )
    // Work now lends the sidebar model to its phone presentation. Reintroducing
    // the former whole-slice helper would cross that boundary even with stable arrays.
    expect(workScreen).toContain("from '@podium/client-graph/worklist/view-model'")
    expect(workScreen).not.toMatch(/\bmissionProgress\s*\(/)

    missionLegacyStats.enable()
    missionLegacyStats.reset()
    const at = '2026-10-03T19:30:00Z'
    const task = (id: string, patch: object = {}) => ({
      kind: 'issue' as const,
      id,
      value: {
        id,
        seq: 1,
        title: id,
        stage: 'backlog',
        type: 'task',
        audience: 'human',
        repoPath: '/fixture',
        createdAt: at,
        updatedAt: at,
        deps: [],
        ...patch,
      },
    })
    try {
      for (const scale of [1, 4]) {
        const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(at) })
        pool.apply({
          type: 'replace',
          rows: [
            task('root', { stage: 'in_progress' }),
            task('phase', { parentId: 'root', type: 'phase' }),
            task('done', { parentId: 'phase', stage: 'done', closedAt: at }),
            task('todo', { parentId: 'root' }),
            ...Array.from({ length: 120 * scale }, (_, index) =>
              task(`history-${index}`, { stage: 'done', closedAt: at, archived: true }),
            ),
          ] as never,
        })
        const model = worklistView(pool)
        const row = model.knownRow('root')
        if (!row) throw new Error('The fixture root must have a shared worklist companion')
        const seen: unknown[] = []
        const stop = autorun(() => {
          seen.push(row.progress)
        })
        const reads = vi.spyOn(pool, 'row')
        try {
          expect(worklistView(pool)).toBe(model)
          expect(model.phone.worklist).toBe(model)
          expect(model.row(pool.issueObject('root'))).toBe(row)
          expect(row.progress).toEqual({ total: 2, done: 1, working: 0, waiting: 0, todo: 1 })
          const settledProgress = row.progress
          reads.mockClear()
          for (let read = 0; read < 5; read++) expect(row.progress).toBe(settledProgress)
          expect(reads).not.toHaveBeenCalled()

          runInAction(() =>
            pool.apply({
              type: 'update',
              rows: [
                task('history-0', {
                  stage: 'done',
                  closedAt: at,
                  archived: true,
                  title: 'Renamed history',
                }),
              ] as never,
            }),
          )
          expect(row.progress).toBe(settledProgress)
          expect(seen).toHaveLength(1)
          runInAction(() =>
            pool.apply({
              type: 'update',
              rows: [task('todo', { parentId: 'root', stage: 'done', closedAt: at })] as never,
            }),
          )
          expect(row.progress).toEqual({ total: 2, done: 2, working: 0, waiting: 0, todo: 0 })
          expect(seen).toHaveLength(2)
          expect(missionLegacyStats.read()).toEqual({ missionIssueIds: 0, indexMissionSessions: 0 })
        } finally {
          reads.mockRestore()
          stop()
          pool.dispose()
        }
      }
    } finally {
      missionLegacyStats.disable()
      missionLegacyStats.reset()
    }
  })
})
