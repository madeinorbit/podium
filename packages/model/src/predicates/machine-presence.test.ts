import { expect, it } from 'vitest'
import {
  HOST_REPOS,
  machineChoiceSummary,
  machineChoices,
  machineEmptyState,
  machineRejection,
} from './machine-capability'
import { machinePresence } from './machine-presence'
import { agentCapabilityRejection, isMachineOfflineForLiveTerminal } from './machine-selection'

it.each([
  [{ online: true, onlineKnown: true }, 'Online'],
  [{ online: false, onlineKnown: true }, 'Offline'],
  [{ online: true, onlineKnown: false }, 'Reconnecting'],
  [{ online: false, onlineKnown: false }, 'Reconnecting'],
  // A server listing is current at delivery, without a client freshness marker.
  [{ online: true }, 'Online'],
  [{ online: false }, 'Offline'],
] as const)('classifies %j as %s', (reading, state) => {
  expect(machinePresence(reading)).toBe(state)
})

it.each([
  true,
  false,
])('refuses stale actions without claiming the daemon is offline (last online: %s)', (online) => {
  const machine = {
    id: 'host',
    name: 'Build machine',
    online,
    onlineKnown: false,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { daemon: true },
  }
  expect(agentCapabilityRejection(machine, 'shell')).toBe('reconnecting')
  expect(machineRejection(machine, HOST_REPOS)).toBe('reconnecting')
  expect(isMachineOfflineForLiveTerminal(machine)).toBe(false)
  expect(
    machineEmptyState(machineChoiceSummary(machineChoices([machine], HOST_REPOS)), {
      action: 'host a repository',
      capability: 'host repositories',
    }),
  ).toMatchObject({ title: 'Reconnecting to machines.' })
  expect(agentCapabilityRejection({ ...machine, use: 'denied' }, 'shell')).toBe('unauthorized')
})
