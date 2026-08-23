import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeFileTree } from './WorktreeFileTree'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const listDir = vi.fn()
const openFileInWorktree = vi.fn()
const searchFiles = vi.fn()
vi.mock('@/app/store', () => {
  const useStore = () => ({
    listDir,
    openFileInWorktree,
    trpc: { files: { search: { query: searchFiles } } },
  })
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
    searchFiles.mockReset()
    searchFiles.mockResolvedValue({ paths: [] })
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

  it('sorts numbered names naturally', async () => {
    listDir.mockResolvedValue({
      ok: true,
      path: '/w',
      entries: [
        { name: '10.ts', isDir: false },
        { name: '2.ts', isDir: false },
      ],
    })
    render(<WorktreeFileTree root="/w" />)

    await screen.findByText('2.ts')
    const names = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text) => text?.endsWith('.ts'))
    expect(names).toEqual(['2.ts', '10.ts'])
  })

  it('searches tracked paths and opens the first result permanently with Enter', async () => {
    searchFiles.mockResolvedValue({ paths: ['src/deep/file.ts'] })
    render(<WorktreeFileTree root="/w" machineId={'machine-1' as never} />)
    await screen.findByText('a.ts')
    vi.useFakeTimers()

    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'deep' } })
    await act(async () => void vi.advanceTimersByTime(150))
    await act(async () => void (await Promise.resolve()))

    expect(searchFiles).toHaveBeenCalledWith({
      root: '/w',
      query: 'deep',
      limit: 50,
      machineId: 'machine-1',
    })
    expect(screen.getByText('src/deep')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Search files'), { key: 'Enter' })
    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: 'machine-1',
      root: '/w',
      path: '/w/src/deep/file.ts',
      permanent: true,
    })
  })

  it('moves through search results with arrow keys before opening one', async () => {
    searchFiles.mockResolvedValue({ paths: ['src/first.ts', 'src/second.ts'] })
    render(<WorktreeFileTree root="/w" />)
    await screen.findByText('a.ts')
    vi.useFakeTimers()

    const search = screen.getByLabelText('Search files')
    fireEvent.change(search, { target: { value: 'src' } })
    await act(async () => void vi.advanceTimersByTime(150))
    await act(async () => void (await Promise.resolve()))
    fireEvent.keyDown(search, { key: 'ArrowDown' })

    expect(search.getAttribute('aria-activedescendant')).toContain('-1')
    expect(screen.getByRole('option', { name: /second\.ts/ }).getAttribute('aria-selected')).toBe(
      'true',
    )
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(openFileInWorktree).toHaveBeenCalledWith({
      machineId: undefined,
      root: '/w',
      path: '/w/src/second.ts',
      permanent: true,
    })
  })
})
