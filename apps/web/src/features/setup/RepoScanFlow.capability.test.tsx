// @vitest-environment happy-dom
/**
 * THE REPORTED FAILURE, RENDERED (POD-2700).
 *
 * The operator could not add a repository: the repo screen was pinned to the
 * server-only coordinator, which runs no daemon and can never host a repo. It
 * was pinned because the picker hid itself at one machine and the auto-pick's
 * last fallback was `machines[0]` — so the dud was selected invisibly, and every
 * action on it dead-ended in "Choose an online machine".
 *
 * These render the screen against exactly that fleet and assert the two halves
 * of the fix: the coordinator is not offered, and the screen SAYS SO — because a
 * silently empty picker is the same defect wearing a different face.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoScanFlow } from './RepoScanFlow'

const browse = vi.fn(async (input?: { path?: string; machineId?: string }) => ({
  path: `/home/${input?.machineId ?? 'user'}`,
  homePath: `/home/${input?.machineId ?? 'user'}`,
  parentPath: '/home',
  entries: [],
}))
const refreshRepos = vi.fn(async () => undefined)

/** The coordinator: it runs the Podium server, and nothing else. */
const COORDINATOR = {
  id: 'source',
  name: 'source',
  hostname: 'source',
  online: true,
  lastSeenAt: '2026-08-24T08:00:00.000Z',
  components: ['server'],
}
const LAPTOP = {
  id: 'mango',
  name: 'mango',
  hostname: 'mango',
  online: true,
  lastSeenAt: '2026-08-24T08:00:00.000Z',
  components: ['daemon'],
}
const SLEEPING = { ...LAPTOP, id: 'kiwi', name: 'kiwi', online: false }

const store: { machines: unknown[]; trpc: unknown; refreshRepos: unknown; uiState: unknown } = {
  machines: [],
  trpc: {
    repos: {
      add: { mutate: vi.fn(async () => []) },
      addMany: { mutate: vi.fn(async () => ({ repos: [], failed: [] })) },
      remove: { mutate: vi.fn(async () => []) },
      browse: { query: browse },
      createRepo: { mutate: vi.fn() },
      createFolder: { mutate: vi.fn() },
      renameFolder: { mutate: vi.fn() },
    },
    discovery: { scanMachine: { mutate: vi.fn() } },
  },
  refreshRepos,
  uiState: { get: () => null, set: () => {} },
}

vi.mock('@/app/store', () => {
  const useStore = () => store
  return {
    useStore,
    useReplicaIssues: () => [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const open = (machines: unknown[]): void => {
  store.machines = machines
  render(<RepoScanFlow onClose={() => {}} onDone={() => {}} />)
}

describe('the repo screen offers only machines that can host a repo', () => {
  it('leaves the server-only coordinator out of the picker', async () => {
    open([COORDINATOR, LAPTOP, SLEEPING])
    const select = (await screen.findByLabelText('Machine')) as HTMLSelectElement
    const options = [...select.querySelectorAll('option')]

    expect(options.map((o) => o.value)).toEqual(['mango', 'kiwi'])
    // OFFLINE IS NOT INCAPABLE: kiwi is still on the list, disabled and labelled,
    // because bringing it online is advice the operator can act on.
    expect(options.map((o) => o.textContent)).toEqual(['mango', 'kiwi (offline)'])
    expect(options.map((o) => o.disabled)).toEqual([false, true])
    // ...and the coordinator's absence is stated, not silent.
    expect(screen.getByText(/can't host repositories/)).toBeTruthy()
    expect(screen.getByText(/source/)).toBeTruthy()
  })

  it('auto-picks a capable machine, never the coordinator', async () => {
    open([COORDINATOR, LAPTOP])
    const select = (await screen.findByLabelText('Machine')) as HTMLSelectElement
    expect(select.value).toBe('mango')
    // And the browse it fires goes to the machine that can answer it.
    expect(browse).toHaveBeenCalledWith({ includeHidden: false, machineId: 'mango' })
  })

  it('never browses a machine with no daemon, even as the only row', async () => {
    open([COORDINATOR])
    await screen.findByText(/No machine can host a repository yet/)
    expect(browse).not.toHaveBeenCalled()
  })
})

describe('the empty state says WHICH situation the operator is in', () => {
  it('only a coordinator: names it, and says to pair a daemon machine', async () => {
    open([COORDINATOR])
    expect(await screen.findByText(/No machine can host a repository yet/)).toBeTruthy()
    expect(screen.getByText(/runs only the Podium server/)).toBeTruthy()
    expect(screen.getByText(/Pair a machine that runs the Podium daemon/)).toBeTruthy()
    // The advice that would waste the operator's time is absent.
    expect(screen.queryByText(/is offline — its folders/)).toBeNull()
  })

  it('capable machine asleep: keeps it selected, and says to wake IT', async () => {
    open([SLEEPING])
    // NOT the empty state, and that is the distinction working rather than a
    // gap in it. kiwi can host repos; it is merely asleep. So it stays selected
    // and named, and the screen gives the advice that WOULD work — which is the
    // opposite of what the coordinator gets one test up. The two situations must
    // not produce the same sentence, and here they do not.
    expect(await screen.findByText(/kiwi is offline — its folders/)).toBeTruthy()
    expect(screen.queryByText(/No machine can host a repository/)).toBeNull()
    // NOT "pair a machine": one already exists and can do the job.
    expect(screen.queryByText(/Pair a machine that runs the Podium daemon/)).toBeNull()
  })
})
