import type { MachineModel } from '@podium/client-graph'
import { expect, test } from 'vitest'
import { MachineReplacementOptions, MachinesSettings, SettingsMachine } from './machine-view'

const machine = (over: object = {}) =>
  ({
    id: 'm1',
    name: 'Build box',
    online: true,
    onlineKnown: true,
    transferable: true,
    ...over,
  }) as MachineModel

test('members see custody and use machines while admins keep the full list', () => {
  const own = machine({ id: 'own', owned: true }),
    use = machine({ id: 'use', use: 'granted' }),
    seen = machine({ id: 'see' })
  expect(new MachinesSettings([own, use, seen], false).visible).toEqual([own, use])
  expect(new MachinesSettings([own, use, seen], true).visible).toEqual([own, use, seen])
})

test('manage and replacement require the server verdict and an active machine', () => {
  expect(new SettingsMachine(machine({ transferable: false })).canManage).toBe(false)
  expect(new SettingsMachine(machine({ revokedAt: 'now' })).canManage).toBe(false)
  expect(new SettingsMachine(machine({ supersededBy: 'm2' })).canManage).toBe(false)
  expect(new SettingsMachine(machine()).canReplace).toBe(false)
  expect(new SettingsMachine(machine({ supersedable: true })).canReplace).toBe(true)
})

test('replacement options exclude the old identity, retired machines and denied targets', () => {
  const old = machine(),
    eligible = machine({ id: 'm2', supersedable: true })
  expect(
    new MachineReplacementOptions(old, [
      old,
      eligible,
      machine({ id: 'revoked', revokedAt: 'now', supersedable: true }),
      machine({ id: 'denied' }),
    ]).candidates,
  ).toEqual([eligible])
})

test('presence, recovery and deliberate hosting-off remain distinct', () => {
  expect(new SettingsMachine(machine({ online: false })).status.label).toBe('Offline')
  expect(new SettingsMachine(machine({ onlineKnown: false })).status.label).toBe('Status unknown')
  expect(
    new SettingsMachine(
      machine({
        online: true,
        daemonReadiness: {
          state: 'recovering',
          reason: 'inventory pending',
          quarantinedBindings: 2,
        },
      }),
    ).status,
  ).toEqual({ label: 'Not ready · inventory pending', tone: 'degraded', detail: '2 quarantined' })
  expect(
    new SettingsMachine(machine({ serviceAssignment: { agentExecution: false } })).status,
  ).toMatchObject({ label: 'Online · Agent hosting off', tone: 'off' })
})
