import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeFileTree } from './WorktreeFileTree'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const listDir = vi.fn()
const openFileInWorktree = vi.fn()
vi.mock('@/app/store', () => {
  const useStore = () => ({ listDir, openFileInWorktree })
  return {
    useStore,
    useReplicaIssues: () => [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

/** Past the 260ms `useClickIntent` window, so a pending single click resolves. */
function settleClickIntent(): void {
  act(() => void vi.advanceTimersByTime(400))
}

describe('WorktreeFileTree', () => {
  beforeEach(() => {
    listDir.mockReset()
    openFileInWorktree.mockReset()
    listDir.mockResolvedValue({
      ok: true,
      path: '/w',
      entries: [
        { name: 'src', isDir: true },
        { name: 'a.ts', isDir: false },
        { name: 'b.ts', isDir: false },
      ],
    })
  })

  it('opens a file as a PREVIEW on a single click', async () => {
    render(<WorktreeFileTree root="/w" />)
    await screen.findByText('a.ts')
    vi.useFakeTimers()

    fireEvent.click(screen.getByText('a.ts'))
    // Nothing yet — the first click cannot act, or every double click would
    // leave a stray preview open behind it.
    expect(openFileInWorktree).not.toHaveBeenCalled()
    settleClickIntent()

    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: undefined,
      root: '/w',
      path: '/w/a.ts',
      permanent: false,
    })
  })

  it('keeps the tab on a double click', async () => {
    render(<WorktreeFileTree root="/w" />)
    await screen.findByText('a.ts')
    vi.useFakeTimers()

    fireEvent.click(screen.getByText('a.ts'))
    fireEvent.click(screen.getByText('a.ts'))
    settleClickIntent()

    expect(openFileInWorktree).toHaveBeenCalledTimes(1)
    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: undefined,
      root: '/w',
      path: '/w/a.ts',
      permanent: true,
    })
  })

  it('counts two rows as two singles, not one double', async () => {
    render(<WorktreeFileTree root="/w" />)
    await screen.findByText('a.ts')
    vi.useFakeTimers()

    fireEvent.click(screen.getByText('a.ts'))
    fireEvent.click(screen.getByText('b.ts'))
    settleClickIntent()

    expect(openFileInWorktree.mock.calls.map(([args]) => [args.path, args.permanent])).toEqual([
      ['/w/a.ts', false],
      ['/w/b.ts', false],
    ])
  })

  it('folds a directory on the FIRST click — a fold that waits reads as lag', async () => {
    render(<WorktreeFileTree root="/w" />)
    await screen.findByText('src')

    listDir.mockResolvedValue({
      ok: true,
      path: '/w/src',
      entries: [{ name: 'x.ts', isDir: false }],
    })
    fireEvent.click(screen.getByText('src'))

    await waitFor(() => expect(screen.getByText('x.ts')).toBeTruthy())
    expect(openFileInWorktree).not.toHaveBeenCalled()
  })
})
