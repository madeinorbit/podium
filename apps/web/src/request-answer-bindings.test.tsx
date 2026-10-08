import { MobxPool } from '@podium/client-graph'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileDocument } from './features/files/useFileDocument'
import { useFileMentions } from './lib/at-mention/useFileMentions'
import { useConversationSearch } from './lib/useConversationSearch'

const f = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  search: vi.fn(),
  files: vi.fn(),
  pool: null as MobxPool | null,
}))
const trpc = {
  conversations: { search: { query: f.search } },
  files: { search: { query: f.files } },
}
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ access: { readFileScoped: f.read, writeFileScoped: f.write, trpc } }),
}))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (read: (s: unknown) => unknown) => read({ trpc }),
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => f.pool }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
beforeEach(() => {
  f.pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  f.pool?.dispose()
  f.pool = null
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

it('closes the actual document hook model and frees its answer and buffer', async () => {
  f.read.mockResolvedValue({ ok: true, content: 'text', baseHash: 'hash' })
  const hook = renderHook(() => useFileDocument({ kind: 'worktree', root: '/repo' }, 'a.md'))
  await waitFor(() => expect(hook.result.current.status).toBe('ready'))
  const view = hook.result.current
  hook.unmount()
  expect(view.answer).toBeUndefined()
  expect(view.content).toBe('')
  expect(view.saveFeedback).toBeNull()
})
it('drops a debounced conversation response after disabling or unmounting its view', async () => {
  const late = deferred<{ id: string; agentKind: string; providerId: string }[]>()
  f.search.mockReturnValue(late.promise)
  const hook = renderHook(
    ({ enabled }) => useConversationSearch({ query: 'query', limit: 6, enabled, debounceMs: 0 }),
    { initialProps: { enabled: true } },
  )
  await waitFor(() => expect(f.search).toHaveBeenCalledOnce())
  const view = hook.result.current!
  hook.rerender({ enabled: false })
  await act(async () => {
    late.resolve([{ id: 'late', agentKind: 'codex', providerId: 'codex' }])
    await late.promise
  })
  expect(view.answer).toBeUndefined()
  expect(view.hits).toEqual([])
  expect(view.loading).toBe(false)
  hook.unmount()
  expect(view.answer).toBeUndefined()
})
it('debounces file mentions, keeps the bounded query and drops a response after closing the menu', async () => {
  const late = deferred<{ paths: string[] }>()
  f.files.mockReturnValue(late.promise)
  const hook = renderHook(
    ({ enabled, query }) =>
      useFileMentions({ query, root: '/repo', enabled, limit: 6, debounceMs: 0 }),
    { initialProps: { enabled: true, query: 'src' } },
  )
  await waitFor(() => expect(f.files).toHaveBeenCalledOnce())
  expect(f.files).toHaveBeenCalledWith({ root: '/repo', query: 'src', limit: 6 })
  hook.rerender({ enabled: false, query: 'src' })
  await act(async () => {
    late.resolve({ paths: ['src/late.ts'] })
    await late.promise
  })
  expect(hook.result.current).toEqual([])
  hook.rerender({ enabled: true, query: '' })
  expect(f.files).toHaveBeenCalledTimes(1)
})
