
import * as runtimePool from '@podium/client-graph/runtime-pool'
import { expect, it, vi } from 'vitest'

  it('builds the workspace pool even with all retired URL overrides off', async () => {
    history.replaceState(null, '', '/?mobxSidebar=0&mobxPane=0&mobxHeader=0&mobxSessionPane=0&mobxBoard=0')
    const create = vi.spyOn(runtimePool, 'createRuntimeWorklistPool')
    render()
    await ready()
    expect(create).toHaveBeenCalledTimes(1)
    expect(replicaFactory).toHaveBeenCalledTimes(1)
    history.replaceState(null, '', '/')
  })


