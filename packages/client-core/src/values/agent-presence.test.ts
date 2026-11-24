import { asMachineId } from '@podium/model'
import { expect, it } from 'vitest'
import { agentFleetStatus, agentMachineStatus, candidateFromAvailability } from './agent-capability'
import {
  activationReadinessCopy,
  agentCanLaunch,
  agentReadinessOnMachines,
} from './agent-readiness'

it.each([
  true,
  false,
])('keeps stale host refusals neutral and launch disabled (last online: %s)', (online) => {
  const machine = {
    id: asMachineId('host'),
    name: 'Build machine',
    online,
    onlineKnown: false,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot', daemon: true, server: false, supervisor: true },
  }
  const candidate = candidateFromAvailability(machine, 'unreachable', 'codex')
  expect(candidate.rejection).toBe('reconnecting')
  expect(agentFleetStatus([candidate], 'Codex')).toMatchObject({ hint: 'reconnecting' })
  expect(agentMachineStatus(machine, 'codex', 'Codex').reason).toContain('Reconnecting')
  const readiness = agentReadinessOnMachines([machine], 'codex')
  expect(readiness.state).toBe('reconnecting')
  expect(agentCanLaunch(readiness, { headed: true })).toBe(false)
  expect(activationReadinessCopy(readiness, 'Codex')).toContain('Reconnecting')
})
