import { rankFirstTaskRepositories } from '@podium/client-core/new-task'
import { useFirstTaskRepositoryPicker } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import {
  createRepositoryUsageSelector,
  indexedRepoUsageAt,
  resolveDefaultAgent,
} from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { SETUP_SESSION_SUMMARY_FIELDS } from '@podium/client-graph/settings-schema'
import { attachSettingsSource, type SettingsOwner } from '@podium/client-graph/settings-source'
import { createColdIndex } from '@podium/client-graph/shared/cold-index'
import { SCHEMA } from '@podium/client-graph/shared/schema'
import type { RowRecord } from '@podium/client-graph/shared/source'
import type { GitRepositoryWire } from '@podium/model'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSettingsCatalog, useSettingsSetupSummary } from '../settings/readers'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => state.pool,
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) => {
    const pool = state.pool
    // biome-ignore lint/correctness/useExhaustiveDependencies: the fixture replaces its pool between separately mounted openings.
    const projection = useMemo(() => pool && createPoolProjection(pool, read), [pool, read])
    return useSyncExternalStore(
      projection?.subscribe ?? (() => () => {}),
      projection?.getSnapshot ?? (() => empty),
    )
  },
}))

afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
  vi.restoreAllMocks()
})

it('preserves desktop New task summary and picker output with one activity query per changed path at 1x/4x', async () => {
  const counts: number[] = []
  for (const scale of [1, 4]) {
    const recent = '2026-01-02T00:00:00Z'
    const repos = Array.from({ length: 32 * scale }, (_, at) => ({
      kind: 'repository',
      path: `/project/p${String(at).padStart(3, '0')}`,
      worktrees: [],
    })) as GitRepositoryWire[]
    const targetPath = repos[1]?.path
    if (!targetPath) throw new Error('Missing target repository')
    const session = (id: string, cwd: string, at: string): RowRecord => ({
      kind: 'session',
      id,
      value: {
        sessionId: id,
        agentKind: 'codex',
        cwd,
        status: 'live',
        createdAt: at,
        lastActiveAt: at,
      },
    })
    let rows = [
      session('target', targetPath, recent),
      ...Array.from({ length: 128 * scale }, (_, at) =>
        session(`foreign-${at}`, '/foreign', '2026-01-01T00:00:00Z'),
      ),
    ]
    const cold = createColdIndex(SCHEMA, { session: SETUP_SESSION_SUMMARY_FIELDS })
    cold.apply({ type: 'replace', rows })
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(recent) }, undefined, {
      settings: true,
      cold: () => cold,
      load: () => undefined,
    })
    state.pool = pool
    pool.apply({ type: 'replace', rows })
    attachSettingsSource(pool, {
      listIds: (name: string) => (name === 'repos' ? repos.map((repo) => repo.path) : []),
      listRow: (name: string, id: string) =>
        name === 'repos' ? repos.find((repo) => repo.path === id) : undefined,
      readLocal: () => 'sessions',
      onList: () => () => {},
      onLocals: () => () => {},
    } as unknown as SettingsOwner)
    const activity = vi.spyOn(pool.queries, 'activity')
    const hook = renderHook(() => {
      const catalog = useSettingsCatalog()
      const summary = useSettingsSetupSummary(catalog.repos)
      return {
        catalog,
        summary,
        picker: useFirstTaskRepositoryPicker(catalog.repos, summary.usage),
      }
    })
    const expected = () => {
      const sessions = rows.map((row) => row.value) as unknown as SessionView[]
      const legacyUsage = createRepositoryUsageSelector()(sessions)
      const usage = new Map(
        repos.flatMap((repo) => {
          const at = indexedRepoUsageAt(repo, legacyUsage)
          return at > 0 ? [[repo.path, at] as const] : []
        }),
      )
      expect(hook.result.current.summary).toEqual({
        usage,
        defaultAgent: resolveDefaultAgent(undefined, sessions),
        pending: 0,
      })
      return rankFirstTaskRepositories(repos, usage)
    }
    try {
      await waitFor(() => expect(hook.result.current.catalog.repos).toEqual(repos))
      expect(hook.result.current.picker.repoChoices).toEqual(expected())
      act(() => hook.result.current.picker.onOpenChange(true))
      const presented = hook.result.current.picker.repoChoices
      activity.mockClear()
      const changed = session('target', targetPath, '2026-01-03T00:00:00Z')
      act(() => {
        rows = [changed, ...rows.slice(1)]
        cold.apply({ type: 'update', rows: [changed] })
        pool.apply({ type: 'update', rows: [changed] })
      })
      counts.push(activity.mock.calls.length)
      expect(activity).toHaveBeenCalledExactlyOnceWith({
        kind: 'commandRootActivity',
        roots: [targetPath],
        agentsOnly: true,
      })
      expected()
      expect(hook.result.current.picker.repoChoices).toBe(presented)
      act(() => hook.result.current.picker.onOpenChange(false))
      act(() => hook.result.current.picker.onOpenChange(true))
      expect(hook.result.current.picker.repoChoices).toEqual(expected())
    } finally {
      hook.unmount()
      activity.mockRestore()
      pool.dispose()
      state.pool = null
    }
  }
  expect(counts).toEqual([1, 1])
})
