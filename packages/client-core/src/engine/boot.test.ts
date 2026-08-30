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
})
