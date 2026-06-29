import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { FileBrowserModal } from './FileBrowserModal'

const listDir = vi.fn()
const openFileInWorktree = vi.fn()
vi.mock('./store', () => ({ useStore: () => ({ listDir, openFileInWorktree }) }))
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

describe('FileBrowserModal', () => {
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
