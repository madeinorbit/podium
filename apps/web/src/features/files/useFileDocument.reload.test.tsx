import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerReloadPreparation, withReloadPreparation } from '@/lib/reload-preparation'
import { useFileDocument } from './useFileDocument'

const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ access: { readFileScoped: read, writeFileScoped: write } }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

beforeEach(() => {
  read.mockResolvedValue({ ok: true, content: 'saved text', baseHash: 'disk' })
  write.mockReset()
  registerReloadPreparation(async () => {})
})
afterEach(() => cleanup())

describe('file edits during update reload', () => {
  it('keeps unsaved editor content on screen, and permits reload after an explicit save', async () => {
    const { result } = renderHook(() =>
      useFileDocument({ kind: 'worktree', root: '/repo' }, 'notes.md'),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.setContent('unsaved edit'))
    const navigate = vi.fn()
    await expect(withReloadPreparation(navigate)).rejects.toThrow('Save or discard')
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.content).toBe('unsaved edit')
    write.mockResolvedValue({ ok: true, baseHash: 'saved' })
    await act(() => result.current.save())
    await withReloadPreparation(navigate)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('preserves edits typed while an earlier version is being saved', async () => {
    const { result } = renderHook(() =>
      useFileDocument({ kind: 'worktree', root: '/repo' }, 'notes.md'),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.setContent('first edit'))
    let release: (value: unknown) => void = () => {}
    write.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    let saving: Promise<void> = Promise.resolve()
    act(() => {
      saving = result.current.save()
    })
    act(() => result.current.setContent('last edit during save'))
    const navigate = vi.fn()
    await expect(withReloadPreparation(navigate)).rejects.toThrow('Save or discard')
    await act(async () => {
      release({ ok: true, baseHash: 'saved' })
      await saving
    })
    expect(result.current.dirty).toBe(true)
    await expect(withReloadPreparation(navigate)).rejects.toThrow('Save or discard')
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.content).toBe('last edit during save')
  })
})
