// @vitest-environment happy-dom
import '@/test-support/model-catalog-mock'
import type { RowRecord } from '@podium/client-graph'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, render } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { REF_PREFIXES_CHANGED_EVENT } from '@/lib/ref-activation'
import { measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { RefPrefixSync } from './RefMiniview'

const state = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  listDetailed: vi.fn(async () => []),
  repositoryKey: vi.fn(() => ''),
  prefixes: vi.fn(),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => state.pool,
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const view = useMemo(() => createPoolProjection(state.pool!, read), [read])
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
vi.mock('@/app/store', () => {
  const store = { trpc: { repos: { listDetailed: { query: state.listDetailed } } } }
  return { useRuntimeSelector: (select: (value: typeof store) => unknown) => select(store) }
})
vi.mock('@/features/chat/use-chat-context', () => ({
  useChatRepositoryKey: state.repositoryKey,
  useChatReferenceMachines: () => [],
}))
vi.mock('@/lib/markdown-references', () => ({ setKnownRefPrefixes: state.prefixes }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  state.prefixes.mockClear()
  state.listDetailed.mockClear()
  state.repositoryKey.mockClear()
})

const repo = (id: string, prefix: string, patch: object = {}): RowRecord =>
  ({
    kind: 'worktree',
    id,
    value: { prefix, ...patch },
  }) as RowRecord

it('bounds the actual root-mounted prefix reader on mount, unrelated updates and prefix changes at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    state.pool = pool
    pool.apply({
      type: 'replace',
      rows: Array.from({ length: 128 * scale }, (_, n) => repo(`r${n}`, `PREFIX${n}`)),
    })
    const keys = vi.spyOn(pool.tables.repo, 'keys'),
      ids = vi.spyOn(pool.queries, 'ids')
    const measure = (action: () => void) =>
      measureWork(
        async () => {
          act(action)
          await act(async () => {})
        },
        { pool },
      )
    let view: ReturnType<typeof render> | undefined
    try {
      const first = await measure(() => {
        view = render(<RefPrefixSync />)
      })
      expect(state.prefixes.mock.lastCall?.[0]).toEqual(
        new Set(Array.from({ length: 128 * scale }, (_, n) => `PREFIX${n}`)),
      )
      state.prefixes.mockClear()
      const metadata = await measure(() =>
        pool.apply({ type: 'update', rows: [repo('r0', 'PREFIX0', { repoName: 'Renamed' })] }),
      )
      expect(state.prefixes).not.toHaveBeenCalled()
      const rename = await measure(() => pool.apply({ type: 'update', rows: [repo('r0', 'NEW')] }))
      expect(state.prefixes.mock.lastCall?.[0].has('NEW')).toBe(true)
      expect(state.prefixes.mock.lastCall?.[0].has('PREFIX0')).toBe(false)
      const event = await measure(() => window.dispatchEvent(new Event(REF_PREFIXES_CHANGED_EVENT)))
      expect(state.listDetailed).not.toHaveBeenCalled()
      expect(state.repositoryKey).not.toHaveBeenCalled()
      expect(keys).not.toHaveBeenCalled()
      expect(ids).not.toHaveBeenCalled()
      expect(first.work.rows).toBe(0)
      samples.push({
        first: first.work,
        metadata: metadata.work,
        rename: rename.work,
        event: event.work,
      })
    } finally {
      view?.unmount()
      keys.mockRestore()
      ids.mockRestore()
      pool.dispose()
      state.prefixes.mockClear()
      state.listDetailed.mockClear()
      state.repositoryKey.mockClear()
    }
  }
  for (const action of ['first', 'metadata', 'rename', 'event'] as const)
    for (const counter of ['rows', 'derivations'] as const)
      expect(samples[1]![action][counter]).toBe(samples[0]![action][counter])
  console.info('[actual root prefix sync work1x4x]', JSON.stringify(samples))
})
