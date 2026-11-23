import type { FileScope } from '@podium/client-core/values'
import { asMachineId } from '@podium/model'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileDocument } from './useFileDocument'

const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@podium/client-core/react', async () => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return fixtureRuntimeHooks(() => ({ access: { readFileScoped: read, writeFileScoped: write } }))
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const firstScope = { kind: 'worktree', root: '/repo', machineId: asMachineId('machine-a') } as const
const secondScope = { ...firstScope, machineId: asMachineId('machine-b') }

beforeEach(() => {
  read.mockReset()
  write.mockReset().mockResolvedValue({ ok: true, baseHash: 'saved' })
})
afterEach(cleanup)

it('retains edits for the same machine and replaces the buffer and save target when the machine changes', async () => {
  read.mockImplementation(async (scope: FileScope) => ({
    ok: true,
    content: scope === firstScope ? 'first contents' : 'second contents',
    baseHash: scope === firstScope ? 'first hash' : 'second hash',
  }))
  const { result, rerender } = renderHook(
    ({ scope }: { scope: FileScope }) => useFileDocument(scope, 'notes.md'),
    { initialProps: { scope: firstScope } },
  )
  await waitFor(() => expect(result.current.content).toBe('first contents'))
  const first = result.current
  act(() => first.setContent('unsaved first edit'))
  rerender({ scope: { ...firstScope } })
  expect(result.current).toBe(first)
  expect(result.current.content).toBe('unsaved first edit')
  expect(read).toHaveBeenCalledTimes(1)

  rerender({ scope: secondScope })
  await waitFor(() => expect(result.current.content).toBe('second contents'))
  expect(result.current).not.toBe(first)
  expect(result.current.dirty).toBe(false)
  expect(read).toHaveBeenLastCalledWith(secondScope, 'notes.md')
  act(() => result.current.setContent('second edit'))
  await act(() => result.current.save())
  expect(write).toHaveBeenCalledExactlyOnceWith({
    scope: secondScope,
    path: 'notes.md',
    content: 'second edit',
    baseHash: 'second hash',
  })
})

it('ignores a late read from the earlier machine after switching scopes', async () => {
  let finishFirst: (value: unknown) => void = () => {}
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve
      }),
  )
  read.mockResolvedValueOnce({ ok: true, content: 'second contents', baseHash: 'second hash' })
  const { result, rerender } = renderHook(
    ({ scope }: { scope: FileScope }) => useFileDocument(scope, 'notes.md'),
    { initialProps: { scope: firstScope } },
  )
  rerender({ scope: secondScope })
  await waitFor(() => expect(result.current.content).toBe('second contents'))
  act(() => result.current.setContent('second edit'))
  await act(async () => {
    finishFirst({ ok: true, content: 'late first contents', baseHash: 'first hash' })
  })
  expect(result.current.content).toBe('second edit')
  expect(result.current.baseHash).toBe('second hash')
  expect(result.current.dirty).toBe(true)
})
