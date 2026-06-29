import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { FileBrowserModal } from './FileBrowserModal'

afterEach(() => cleanup())

const listDir = vi.fn()
const openFileInWorktree = vi.fn()
vi.mock('./store', () => ({ useStore: () => ({ listDir, openFileInWorktree }) }))
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

describe('FileBrowserModal', () => {
  it('disables Up at the root', async () => {
    listDir.mockResolvedValue({ ok: true, path: '/w', entries: [{ name: 'src', isDir: true }] })
    render(<FileBrowserModal root="/w" title="files" onClose={vi.fn()} />)
    await screen.findByText('src')
    expect((screen.getByLabelText('Up') as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists entries, navigates into a dir, opens a file', async () => {
    listDir.mockImplementation(async ({ path }: { path?: string }) =>
      path && path.endsWith('/src')
        ? { ok: true, path, entries: [{ name: 'index.ts', isDir: false }] }
        : { ok: true, path: '/w', entries: [{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }] },
    )
    const onClose = vi.fn()
    render(<FileBrowserModal root="/w" title="files" onClose={onClose} />)

    await screen.findByText('src')
    fireEvent.click(screen.getByText('src'))
    await screen.findByText('index.ts')
    fireEvent.click(screen.getByText('index.ts'))

    await waitFor(() =>
      expect(openFileInWorktree).toHaveBeenCalledWith({ machineId: undefined, root: '/w', path: '/w/src/index.ts' }),
    )
    expect(onClose).toHaveBeenCalled()
  })
})
