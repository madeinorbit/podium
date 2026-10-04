import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const current = vi.hoisted(() => ({ owner: null as unknown as { getSnapshot(): Record<string, unknown> }, legacy: vi.fn() }))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => current.owner,
  useRuntimeSelector: (select: (state: Record<string, unknown>) => unknown) => { current.legacy(); return select(current.owner.access) },
}))
vi.mock('../client/demoData', () => ({ demoEnabled: () => false }))
import { useHttpOrigin, useHub, useReplica, useStoreActions, useTrpc, useUiState } from '../client/hooks'
it('acquires stable mobile actions and handles once per owner without legacy subscriptions', () => {
  const make = (name: string) => {
    const snapshot = { httpOrigin: name, trpc: {}, hub: {}, replica: {}, uiState: {}, markIssueRead: vi.fn() }
    return { snapshot, getSnapshot: () => snapshot }
  }
  const first = make('first'), second = make('second')
  current.owner = first
  const { result, rerender, unmount } = renderHook(() => ({
    origin: useHttpOrigin(), trpc: useTrpc(), hub: useHub(), replica: useReplica(), ui: useUiState(), actions: useStoreActions(),
  }))
  const actions = result.current.actions
  rerender()
  expect(result.current.actions).toBe(actions)
  expect(result.current).toMatchObject({ origin: 'first', trpc: first.snapshot.trpc, hub: first.snapshot.hub, replica: first.snapshot.replica, ui: first.snapshot.uiState })
  current.owner = second; rerender()
  expect(result.current.actions).not.toBe(actions)
  expect(result.current).toMatchObject({ origin: 'second', trpc: second.snapshot.trpc, hub: second.snapshot.hub, replica: second.snapshot.replica, ui: second.snapshot.uiState })
  result.current.actions.markIssueRead('synthetic' as never)
  expect(second.snapshot.markIssueRead).toHaveBeenCalledOnce()
  expect(first.snapshot.markIssueRead).not.toHaveBeenCalled()
  expect(current.legacy).not.toHaveBeenCalled()
  unmount()
})
