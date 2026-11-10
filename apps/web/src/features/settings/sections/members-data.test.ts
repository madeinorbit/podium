import type { MemberDirectoryAnswer } from '@podium/client-graph/member-directory'
import { MobxPool } from '@podium/client-graph/pool'
import { expect, test } from 'vitest'
import { deviceLabel, MembersPage } from './members-data'

test('person companions match sign-ins and machine custody by member id', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'settingsCatalog',
        id: 'catalog',
        value: { id: 'catalog', machines: ['mine', 'theirs'], repositories: [] },
      },
      { kind: 'machine', id: 'mine', value: { id: 'mine', name: 'My machine', custodian: 'anna' } },
      {
        kind: 'machine',
        id: 'theirs',
        value: { id: 'theirs', name: 'Their machine', custodian: 'admin' },
      },
    ],
  })
  const page = new MembersPage(pool)
  await page.read(
    async () =>
      ({
        members: [
          {
            id: 'anna',
            displayName: 'Anna Smith',
            role: 'member',
            email: 'anna@example.com',
            disabledAt: null,
          },
        ],
        currentMemberId: 'admin',
        invites: [],
        mailAvailable: false,
        actions: { anna: ['remove'] },
      }) as MemberDirectoryAnswer,
  )
  await page.devices.load(async () => ({
    signInsTotal: 5,
    signIns: [
      {
        id: 'phone',
        memberId: 'anna',
        deviceName: null,
        platform: null,
        kind: 'mobile',
        createdAt: '',
        lastSeenAt: null,
        expiresAt: '',
      },
      {
        id: 'browser',
        memberId: 'admin',
        deviceName: 'Browser',
        platform: null,
        kind: 'login',
        createdAt: '',
        lastSeenAt: null,
        expiresAt: '',
      },
    ],
  }))
  const member = page.members[0]
  if (!member) throw new Error('Expected a member')
  const person = page.person(member)
  expect(person.initials).toBe('AS')
  expect(person.self).toBe(false)
  expect(person.allows('remove')).toBe(true)
  expect(person.allows('setRole')).toBe(false)
  expect(person.devices.map((device) => device.id)).toEqual(['phone'])
  expect(person.machines.map((machine) => machine.name)).toEqual(['My machine'])
  expect(page.devicesTruncated).toBe(true)
  expect(deviceLabel(person.devices[0]!)).toBe('Phone')
  page.dispose()
  pool.dispose()
})
