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

  it('discards an older response after a machine invalidation starts a newer refresh', async () => {
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

    const older = boot.refreshRepos()
    const newer = boot.refreshRepos()
    resolveFresh(fresh)
    await newer
    resolveStale(stale)
    await older

    expect(publish.mock.calls.filter(([patch]) => patch.repos !== undefined)).toEqual([
      [{ repos: fresh.repositories, repoDiagnostics: [], machines: fresh.machines }],
    ])
  })
})
