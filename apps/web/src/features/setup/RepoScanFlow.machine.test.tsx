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
// The browse response is git-aware (POD-855): each entry says whether it's a repo,
// and the browsed folder carries its own repo identity. `myrepo` is a repo; the
// home listing you land on is not.
const browse = vi.fn(async (input?: { path?: string; machineId?: string }) => {
  const path = input?.path ?? `/home/${input?.machineId ?? 'user'}`
  const isRepo = path.endsWith('/myrepo')
  return {
    path,
    homePath: `/home/${input?.machineId ?? 'user'}`,
    parentPath: '/home',
    entries: [
      { name: 'myrepo', path: `${path}/myrepo`, isRepo: true },
      { name: 'src', path: `${path}/src`, isRepo: false },
    ],
    ...(isRepo ? { isRepo: true, originUrl: 'git@github.com:lumenfall/myrepo.git' } : {}),
  }
})
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
      scanMachine: { mutate: scanMachine },
    },
  },
  refreshRepos,
}

vi.mock('@/app/store', () => {
  const useStore = () => store
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
    expect(select.value).toBe('podium-host')
  })

  it('browses the DEFAULT machine through its daemon on open', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({ includeHidden: false, machineId: 'podium-host' }),
    )
  })

  it('re-browses the newly selected machine as you navigate', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({ includeHidden: false, machineId: 'vmi34' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /src/ }))
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({
        path: '/home/vmi34/src',
        includeHidden: false,
        machineId: 'vmi34',
      }),
    )
  })

  it('adds ONLY a git repo — the button is disabled off a repo, enabled and named on one', async () => {
    const onClose = vi.fn()
    render(<RepoScanFlow onClose={onClose} onDone={() => {}} />)
    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })

    // Landed on a non-repo home: the add button is disabled and generic.
    const addBefore = await screen.findByRole('button', { name: 'Add repo' })
    expect((addBefore as HTMLButtonElement).disabled).toBe(true)

    // Step into a repo folder → the button names it by its origin and enables.
    fireEvent.click(await screen.findByRole('button', { name: /myrepo/ }))
    const add = await screen.findByRole('button', { name: "Add repo 'myrepo'" })
    expect((add as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(add)
    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/myrepo', machineId: 'vmi34' }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('scans from the browsed folder plus the machine (POD-855 atPath)', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    await screen.findByRole('button', { name: /src/ })
    fireEvent.click(screen.getByRole('button', { name: 'Scan for repos' }))

    await waitFor(() =>
      expect(scanMachine).toHaveBeenCalledWith({
        machineId: 'vmi34',
        deep: false,
        atPath: '/home/vmi34',
      }),
    )
  })

  it('commits the scan-results diff to the selected machine: addMany for adds, remove per removal', async () => {
    const onDone = vi.fn()
    render(<RepoScanFlow onClose={() => {}} onDone={onDone} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Scan for repos' }))

    await screen.findByText('known')
    fireEvent.click(screen.getByText('known')) // registered → remove
    fireEvent.click(screen.getByText('fresh')) // candidate → add
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 · Remove 1' }))

    await waitFor(() =>
      expect(addMany).toHaveBeenCalledWith({ paths: ['/home/vmi34/fresh'], machineId: 'vmi34' }),
    )
    expect(removeRepo).toHaveBeenCalledWith({ path: '/home/vmi34/known', machineId: 'vmi34' })
    expect(refreshRepos).toHaveBeenCalled()
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('keeps the typed-path fallback for adding a repo directly', async () => {
    const onClose = vi.fn()
    render(<RepoScanFlow onClose={onClose} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    fireEvent.change(screen.getByLabelText('Repo path on vmi34'), {
      target: { value: '/home/vmi34/podium' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/podium', machineId: 'vmi34' }),
    )
    expect(onClose).toHaveBeenCalled()
  })
})
