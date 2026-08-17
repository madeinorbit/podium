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
const uiValues = new Map<string, string>()

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
  uiState: {
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
    },
  },
}

vi.mock('@/app/store', () => {
  const useStore = () => store
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

afterEach(() => {
  cleanup()
  uiValues.clear()
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
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder src' }))
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({
        path: '/home/vmi34/src',
        includeHidden: false,
        machineId: 'vmi34',
      }),
    )
  })

  it('offers familiar parent, back, and forward navigation', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement
    const forward = screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement
    expect(back.disabled).toBe(true)
    expect(await screen.findByRole('button', { name: 'Open parent folder /home' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open folder src' }))
    await waitFor(() => expect(back.disabled).toBe(false))
    fireEvent.click(back)
    await waitFor(() => expect(forward.disabled).toBe(false))
  })

  it('adds a discovered git repo directly without first navigating into it', async () => {
    const onClose = vi.fn()
    const onDone = vi.fn()
    render(<RepoScanFlow onClose={onClose} onDone={onDone} />)
    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })

    // A discovered repo is directly addable; opening the folder remains a separate action.
    const add = await screen.findByRole('button', { name: 'Use repository myrepo' })
    fireEvent.click(add)
    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/myrepo', machineId: 'vmi34' }),
    )
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(1))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('scans from the browsed folder plus the machine (POD-855 atPath)', async () => {
    render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    await screen.findByRole('button', { name: 'Open folder src' })
    fireEvent.click(screen.getByRole('button', { name: 'Scan this folder' }))

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
    const dialog = screen.getByRole('dialog')
    fireEvent.click(await screen.findByRole('button', { name: 'Scan this folder' }))

    await screen.findByText('known', {}, { timeout: 5_000 })
    expect(screen.getByRole('dialog')).toBe(dialog)
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
    const onDone = vi.fn()
    render(<RepoScanFlow onClose={onClose} onDone={onDone} />)

    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    fireEvent.change(screen.getByLabelText('Repo path on vmi34'), {
      target: { value: '/home/vmi34/podium' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use repository' }))

    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/podium', machineId: 'vmi34' }),
    )
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(1))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers the browsed folder itself once you have navigated INTO a repo (POD-1236)', async () => {
    const onDone = vi.fn()
    render(<RepoScanFlow onClose={() => {}} onDone={onDone} />)
    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })

    const use = screen.getByRole('button', { name: 'Use repository' }) as HTMLButtonElement
    expect(use.disabled).toBe(true) // home listing is not a repo — nothing to offer

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder myrepo' }))
    const field = (await screen.findByLabelText('Repo path on vmi34')) as HTMLInputElement
    await waitFor(() => expect(field.placeholder).toBe('/home/vmi34/myrepo'))
    expect(use.disabled).toBe(false)

    // Typing takes over the offer, and clearing hands it back.
    fireEvent.change(field, { target: { value: 'relative/path' } })
    fireEvent.click(use)
    expect(await screen.findByText('Repo path must be absolute')).toBeTruthy()
    fireEvent.change(field, { target: { value: '' } })
    expect(use.disabled).toBe(false)

    fireEvent.click(use)
    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith({ path: '/home/vmi34/myrepo', machineId: 'vmi34' }),
    )
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(1))
  })

  it('restores the onboarding machine and browsed folder after unmount', async () => {
    const first = render(<RepoScanFlow onboarding onClose={() => {}} onDone={() => {}} />)
    fireEvent.change(await screen.findByLabelText('Machine'), { target: { value: 'vmi34' } })
    fireEvent.click(screen.getByRole('button', { name: /^On this machine/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder src' }))
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({
        path: '/home/vmi34/src',
        includeHidden: false,
        machineId: 'vmi34',
      }),
    )
    first.unmount()
    browse.mockClear()

    render(<RepoScanFlow onboarding onClose={() => {}} onDone={() => {}} />)

    expect(((await screen.findByLabelText('Machine')) as HTMLSelectElement).value).toBe('vmi34')
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith({
        path: '/home/vmi34/src',
        includeHidden: false,
        machineId: 'vmi34',
      }),
    )
  })
})
