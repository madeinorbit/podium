// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoScanFlow } from './RepoScanFlow'

const addRepo = vi.fn(async () => [])
const addMany = vi.fn(async () => ({ repos: [], failed: [] }))
const browse = vi.fn(async () => ({
  path: '/home/user',
  homePath: '/home/user',
  parentPath: '/home',
  entries: [],
}))
const scanFolder = vi.fn(async () => ({ repositories: [], diagnostics: [] }))
const refreshRepos = vi.fn(async () => undefined)

const store = {
  machines: [
    {
      id: 'podium-host',
      name: 'podium-host',
      hostname: 'podium-host',
      online: true,
      lastSeenAt: '2026-07-07T08:00:00.000Z',
    },
    {
      id: 'vmi34',
      name: 'vmi34',
      hostname: 'vmi34',
      online: true,
      lastSeenAt: '2026-07-07T08:00:00.000Z',
    },
  ],
  trpc: {
    repos: {
      add: { mutate: addRepo },
      addMany: { mutate: addMany },
      browse: { query: browse },
    },
    discovery: {
      scanFolder: { mutate: scanFolder },
    },
  },
  refreshRepos,
}

vi.mock('./store', () => ({
  useStore: () => store,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RepoScanFlow machine selection', () => {
  it('adds a manually entered repo path to the selected remote machine', async () => {
    const onClose = vi.fn()
    render(<RepoScanFlow onClose={onClose} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    fireEvent.change(screen.getByLabelText('Repo path on vmi34'), {
      target: { value: '/home/vmi34/podium' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }))

    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/podium', machineId: 'vmi34' }),
    )
    expect(refreshRepos).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
