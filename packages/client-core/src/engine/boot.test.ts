import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { BootFetches } from './boot'
import type { EngineState } from './state'

describe('BootFetches.refreshRepos', () => {
  it('publishes the authorized machine snapshot atomically with a durable repo fallback', async () => {
    const machineId = asMachineId('daemon-after-rebind')
    const repository = {
      path: '/tmp/dummy-repo',
      kind: 'repository',
      machineId,
      worktrees: [],
    } as GitRepositoryWire
    const machine = {
      id: machineId,
      name: 'isolated daemon',
      online: true,
      use: 'granted',
    } as MachineWire
    const publish = vi.fn<(patch: Partial<EngineState>) => void>()
    const api = {
      discovery: {
        refreshRepos: {
          mutate: vi.fn(async () => ({
            repositories: [repository],
            diagnostics: [],
            machines: [machine],
          })),
        },
      },
    } as unknown as PodiumClientApi
    const boot = new BootFetches({
      api,
      publish,
      replicatedLayout: {} as never,
    })

    await boot.refreshRepos()

    expect(publish).toHaveBeenNthCalledWith(1, { reposLoading: true })
    expect(publish).toHaveBeenNthCalledWith(2, {
      repos: [repository],
      repoDiagnostics: [],
      machines: [machine],
    })
    expect(publish).toHaveBeenNthCalledWith(3, {
      reposLoading: false,
      reposLoaded: true,
    })
  })

  it('leaves the newer authorized snapshot standing when a machine invalidation refreshes', async () => {
    type RefreshResult = {
      repositories: GitRepositoryWire[]
      diagnostics: never[]
      machines: MachineWire[]
    }
    const stale = {
      repositories: [
        {
          path: '/tmp/stale-repo',
          kind: 'repository',
          machineId: asMachineId('stale-daemon'),
          worktrees: [],
        } as GitRepositoryWire,
      ],
      diagnostics: [],
      machines: [],
    } satisfies RefreshResult
    const fresh = {
      repositories: [
        {
          path: '/tmp/dummy-repo',
          kind: 'repository',
          machineId: asMachineId('rebound-daemon'),
          worktrees: [],
        } as GitRepositoryWire,
      ],
      diagnostics: [],
      machines: [
        {
          id: asMachineId('rebound-daemon'),
          name: 'rebound daemon',
          online: true,
          use: 'granted',
        } as MachineWire,
      ],
    } satisfies RefreshResult
    let resolveStale!: (value: RefreshResult) => void
    let resolveFresh!: (value: RefreshResult) => void
    const api = {
      discovery: {
        refreshRepos: {
          mutate: vi
            .fn()
            .mockImplementationOnce(
              () => new Promise<RefreshResult>((r) => (resolveStale = r)),
            )
            .mockImplementationOnce(() => new Promise<RefreshResult>((r) => (resolveFresh = r))),
        },
      },
    } as unknown as PodiumClientApi
    const publish = vi.fn<(patch: Partial<EngineState>) => void>()
    const boot = new BootFetches({ api, publish, replicatedLayout: {} as never })

    // Coalescing (see `refreshRepos`) means the second trigger does not race the
    // first on the wire — it joins the trailing run — so the two responses
    // settle in order. What must hold either way is the epic's rule: the newer
    // authorized snapshot is the one left standing, never undone by the older.
    const older = boot.refreshRepos()
    const newer = boot.refreshRepos()
    resolveStale(stale)
    await older
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    resolveFresh(fresh)
    await newer

    const published = publish.mock.calls.filter(([patch]) => patch.repos !== undefined)
    expect(published.at(-1)).toEqual([
      { repos: fresh.repositories, repoDiagnostics: [], machines: fresh.machines },
    ])
  })
})

type Deferred = { resolve: () => void; reject: (error: unknown) => void }

function makeFetches() {
  const deferreds: Deferred[] = []
  const patches: Partial<EngineState>[] = []
  let calls = 0
  const api = {
    discovery: {
      refreshRepos: {
        mutate: () =>
          new Promise<{ repositories: unknown[]; diagnostics: unknown[] }>((resolve, reject) => {
            calls += 1
            deferreds.push({
              resolve: () => resolve({ repositories: [], diagnostics: [] }),
              reject,
            })
          }),
      },
    },
  }
  const fetches = new BootFetches({
    // Only the discovery surface is exercised here; the rest of the api and the
    // layout controller are never touched by refreshRepos.
    api: api as never,
    publish: (patch) => patches.push(patch),
    replicatedLayout: {} as never,
  })
  return { fetches, deferreds, patches, calls: () => calls }
}

/** Let queued promise reactions run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('BootFetches.refreshRepos coalescing', () => {
  it('runs overlapping triggers as one in-flight mutation plus one trailing run', async () => {
    const { fetches, deferreds, calls } = makeFetches()
    const first = fetches.refreshRepos()
    // Three triggers land while the first mutation is on the wire.
    const second = fetches.refreshRepos()
    const third = fetches.refreshRepos()
    expect(calls()).toBe(1)
    // The mid-flight joiners share one promise — the single trailing run.
    expect(second).toBe(third)

    deferreds[0]?.resolve()
    await first
    await tick()
    // Exactly one follow-up went on the wire for all mid-flight triggers.
    expect(calls()).toBe(2)
    deferreds[1]?.resolve()
    await Promise.all([second, third])
    expect(calls()).toBe(2)
  })

  it('coalesces nothing once settled: a later trigger is a fresh mutation', async () => {
    const { fetches, deferreds, calls } = makeFetches()
    const first = fetches.refreshRepos()
    deferreds[0]?.resolve()
    await first
    const second = fetches.refreshRepos()
    expect(calls()).toBe(2)
    deferreds[1]?.resolve()
    await second
    expect(calls()).toBe(2)
  })

  it('still runs the trailing refresh when the in-flight one fails', async () => {
    const { fetches, deferreds, calls } = makeFetches()
    const first = fetches.refreshRepos()
    const trailing = fetches.refreshRepos()
    deferreds[0]?.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await tick()
    // The trailing run is owed regardless of the first run's outcome.
    expect(calls()).toBe(2)
    deferreds[1]?.resolve()
    await expect(trailing).resolves.toBeUndefined()
  })

  it('publishes the loading flips per run, ending settled', async () => {
    const { fetches, deferreds, patches } = makeFetches()
    const first = fetches.refreshRepos()
    const trailing = fetches.refreshRepos()
    deferreds[0]?.resolve()
    await first
    await tick()
    deferreds[1]?.resolve()
    await trailing
    const loading = patches
      .filter((patch) => 'reposLoading' in patch)
      .map((patch) => patch.reposLoading)
    expect(loading).toEqual([true, false, true, false])
  })
})
