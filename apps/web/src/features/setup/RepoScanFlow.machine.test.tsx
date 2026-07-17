// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoScanFlow } from './RepoScanFlow'

const addRepo = vi.fn(async () => [])
const addMany = vi.fn(async () => ({ repos: [], failed: [] }))
const removeRepo = vi.fn(async () => [])
const scanMachine = vi.fn(async () => ({
  repos: [
    { path: '/home/vmi34/known', status: 'registered', alsoOn: [] },
    { path: '/home/vmi34/fresh', status: 'candidate', alsoOn: [] },
  ],
  diagnostics: [],
}))
const lastMachineScan = vi.fn(async () => null)
const browse = vi.fn(async (input?: { path?: string; machineId?: string }) => ({
  path: input?.path ?? `/home/${input?.machineId ?? 'user'}`,
  homePath: `/home/${input?.machineId ?? 'user'}`,
  parentPath: '/home',
  entries: [{ name: 'src', path: `/home/${input?.machineId ?? 'user'}/src` }],
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
      remove: { mutate: removeRepo },
      browse: { query: browse },
    },
    discovery: {
      scanFolder: { mutate: scanFolder },
      scanMachine: { mutate: scanMachine },
      lastMachineScan: { query: lastMachineScan },
    },
  },
  refreshRepos,
}

vi.mock('@/app/store', () => {
  const useStore = () => store
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RepoScanFlow machine selection', () => {
  it('offers only real machines — no "this machine" server-filesystem option', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    const select = (await screen.findByLabelText('Machine')) as HTMLSelectElement
    const options = [...select.querySelectorAll('option')]
    expect(options.map((o) => o.value)).toEqual(['podium-host', 'vmi34'])
    expect(options.some((o) => /this machine/i.test(o.textContent ?? ''))).toBe(false)
    // Defaults to a machine rather than the empty "server host" selection.
    expect(select.value).toBe('podium-host')
  })

  it('browses the DEFAULT machine through its daemon on open', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({ includeHidden: false, machineId: 'podium-host' }),
    )
  })

  it('re-browses the newly selected machine, and targets it when adding the folder', async () => {
    const onClose = vi.fn()
    render(<RepoScanFlow onClose={onClose} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })

    // The browse follows the machine — the previous machine's path means nothing here.
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({ includeHidden: false, machineId: 'vmi34' }),
    )
    // ...and descending into a folder keeps targeting it.
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({
        path: '/home/vmi34/src',
        includeHidden: false,
        machineId: 'vmi34',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add this folder' }))
    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/src', machineId: 'vmi34' }),
    )
    expect(refreshRepos).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('scans the browsed folder on the selected machine', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    await screen.findByRole('button', { name: 'src' })
    fireEvent.click(screen.getByRole('button', { name: 'Scan for repos here' }))

    await waitFor(() =>
      expect(scanFolder).toHaveBeenCalledWith({ path: '/home/vmi34', machineId: 'vmi34' }),
    )
  })

  it('commits the scan-results diff to the selected machine: addMany for adds, remove per removal', async () => {
    const onDone = vi.fn()
    render(<RepoScanFlow onClose={() => {}} onDone={onDone} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Scan for repos' }))

    // The registered row arrives checked; unchecking it queues its removal, and the
    // fresh candidate is queued as an add.
    await screen.findByText('known')
    fireEvent.click(screen.getByText('known'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 · Remove 1' }))

    await waitFor(() =>
      expect(addMany).toHaveBeenCalledWith({
        paths: ['/home/vmi34/fresh'],
        machineId: 'vmi34',
      }),
    )
    expect(removeRepo).toHaveBeenCalledWith({ path: '/home/vmi34/known', machineId: 'vmi34' })
    expect(refreshRepos).toHaveBeenCalled()
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

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
