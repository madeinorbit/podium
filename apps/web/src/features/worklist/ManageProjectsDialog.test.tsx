// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManageProjectsButton } from './ManageProjectsDialog'

const { saveOrder } = vi.hoisted(() => ({ saveOrder: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/app/store', () => ({
  useSlice: () => ({
    projects: [
      { key: 'repo-a', name: 'Alpha', aliases: ['repo-a', '/a'] },
      { key: 'repo-b', name: 'Beta', aliases: ['repo-b', '/b'] },
    ],
  }),
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({
      setSidebarSettings: saveOrder,
      sidebarSettings: { repoOrder: ['repo-a', 'repo-b'] },
    }),
}))

afterEach(() => {
  cleanup()
  saveOrder.mockClear()
})

describe('Manage projects', () => {
  it('saves the order chosen with move buttons', async () => {
    render(<ManageProjectsButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage projects' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Alpha down' }))
    expect(screen.getByRole('status').textContent).toContain('Alpha moved to position 2')
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }))
    await waitFor(() =>
      expect(saveOrder).toHaveBeenCalledWith({
        repoSort: 'custom',
        repoOrder: ['repo-b', 'repo-a'],
      }),
    )
  })

  it('leaves the saved order alone when cancelled', () => {
    render(<ManageProjectsButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage projects' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Alpha down' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(saveOrder).not.toHaveBeenCalled()
  })
})
