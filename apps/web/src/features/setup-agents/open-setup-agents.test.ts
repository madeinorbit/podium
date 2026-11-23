import { asMachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeSetupAgents,
  openSetupAgents,
  setupAgentsRequest,
  switchSetupAgentsMachine,
} from './open-setup-agents'

afterEach(closeSetupAgents)

describe('openSetupAgents', () => {
  it('opens a fresh panel per call and closes it', () => {
    openSetupAgents({ machineId: asMachineId('a'), origin: 'menu' })
    const first = setupAgentsRequest()?.opening
    openSetupAgents({ machineId: asMachineId('a'), origin: 'menu' })
    expect(setupAgentsRequest()?.opening).not.toBe(first)
    closeSetupAgents()
    expect(setupAgentsRequest()).toBeNull()
  })

  it('switching machine keeps the origin and drops the opener’s focus and hand-back', () => {
    const onStart = () => {}
    openSetupAgents({ machineId: asMachineId('a'), origin: 'menu', focus: 'codex', onStart })
    switchSetupAgentsMachine(asMachineId('b'))
    expect(setupAgentsRequest()).toMatchObject({ machineId: 'b', origin: 'menu' })
    expect(setupAgentsRequest()?.focus).toBeUndefined()
    expect(setupAgentsRequest()?.onStart).toBeUndefined()
  })
})
