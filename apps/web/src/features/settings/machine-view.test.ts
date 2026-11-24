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
  expect(new SettingsMachine(machine({ onlineKnown: false })).status.label).toBe('Reconnecting')
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

test('ready machines keep quarantine counts diagnostic and show each count once', () => {
  expect(
    new SettingsMachine(
      machine({
        daemonReadiness: { state: 'ready', reason: '', quarantinedBindings: 2 },
      }),
    ).status,
  ).toEqual({ label: 'Online', tone: 'online', detail: '2 quarantined' })
  expect(
    new SettingsMachine(
      machine({
        daemonReadiness: { state: 'ready', reason: '2 quarantined', quarantinedBindings: 2 },
      }),
    ).status,
  ).toEqual({ label: 'Online', tone: 'online', detail: '2 quarantined' })
  expect(
    new SettingsMachine(
      machine({
        daemonReadiness: { state: 'recovering', reason: '2 quarantined', quarantinedBindings: 2 },
      }),
    ).status,
  ).toEqual({
    label: 'Not ready · recovering bindings',
    tone: 'degraded',
    detail: '2 quarantined',
  })
  expect(
    new SettingsMachine(
      machine({
        daemonReadiness: {
          state: 'recovering',
          reason: 'retrying handshake',
          quarantinedBindings: 2,
        },
      }),
    ).status,
  ).toEqual({
    label: 'Not ready · retrying handshake',
    tone: 'degraded',
    detail: '2 quarantined',
  })
  expect(
    new SettingsMachine(
      machine({
        daemonReadiness: {
          state: 'recovering',
          reason: 'inventory pending',
          quarantinedBindings: 0,
        },
      }),
    ).status,
  ).toEqual({ label: 'Not ready · inventory pending', tone: 'degraded' })
})

test('repository discovery needs execution consent as well as management and presence', () => {
  expect(new SettingsMachine(machine({ use: 'granted' })).canFindRepositories).toBe(true)
  expect(new SettingsMachine(machine({ use: 'denied' })).canFindRepositories).toBe(false)
  expect(new SettingsMachine(machine({ use: 'granted', online: false })).canFindRepositories).toBe(
    false,
  )
  expect(
    new SettingsMachine(machine({ use: 'granted', transferable: false })).canFindRepositories,
  ).toBe(false)
})

test('only a connected machine on a plain link reads as unencrypted', () => {
  expect(new SettingsMachine(machine({ linkKind: 'plain' })).unencrypted).toBe(true)
  for (const linkKind of ['encrypted', 'local', 'trusted', undefined]) {
    expect(new SettingsMachine(machine({ linkKind })).unencrypted, String(linkKind)).toBe(false)
  }
  expect(new SettingsMachine(machine({ linkKind: 'plain', online: false })).unencrypted).toBe(false)
})

test('uninstall needs manage, an online machine, and a machine that does not run the server', () => {
  expect(new SettingsMachine(machine()).canUninstall).toBe(true)
  expect(new SettingsMachine(machine({ online: false })).canUninstall).toBe(false)
  expect(new SettingsMachine(machine({ transferable: false })).canUninstall).toBe(false)
  expect(new SettingsMachine(machine({ hostsServer: true })).canUninstall).toBe(false)
  expect(new SettingsMachine(machine({ serviceAssignment: { server: true } })).canUninstall).toBe(
    false,
  )
})

test.each([
  true,
  false,
])('stale machine status is neutral and cannot enable remote actions (last online: %s)', (online) => {
  const view = new SettingsMachine(
    machine({ online, onlineKnown: false, use: 'granted', linkKind: 'plain' }),
  )
  expect(view.status).toEqual({ label: 'Reconnecting', tone: 'reconnecting' })
  expect(view.canFindRepositories).toBe(false)
  expect(view.canUninstall).toBe(false)
  expect(view.unencrypted).toBe(false)
  expect(view.degradedServices).toEqual([])
})
