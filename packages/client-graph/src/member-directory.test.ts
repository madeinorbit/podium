import type { MemberView } from '@podium/model'
import { expect, test } from 'vitest'
import { isGone, requireHere } from './lookup'
import { MemberDirectory, type MemberDirectoryAnswer } from './member-directory'
import { type MemberRosterAnswer, memberRoster } from './member-roster'
import { MobxPool } from './pool'

const fullMember = (id: string, disabledAt: string | null = null): MemberView => ({
  id,
  displayName: id,
  role: 'member',
  email: `${id}@example.test`,
  accountId: `account-${id}`,
  avatar: `avatar-${id}`,
  createdAt: '2026-01-01T00:00:00Z',
  disabledAt,
})
const adminAnswer = (members: MemberView[]): MemberDirectoryAnswer => ({
  members,
  currentMemberId: 'admin',
  invites: [],
  mailAvailable: true,
  actions: { active: ['setRole'] },
})

test.each([
  'roster',
  'directory',
] as const)('a public %s refresh preserves admin member details and shared model identity', async (reader) => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const directory = new MemberDirectory(pool)
  const publicDirectory = new MemberDirectory(pool)
  const roster = memberRoster(pool)
  const active = fullMember('active')
  const disabled = fullMember('disabled', '2026-02-01T00:00:00Z')
  const answer = adminAnswer([active, disabled])
  try {
    await directory.read(async () => answer)
    await publicDirectory.read(async () => answer)
    const model = directory.members[0]
    const refreshed = { id: active.id, displayName: 'Renamed', role: 'admin' }
    const publicAnswer: MemberRosterAnswer = {
      members: [refreshed],
      currentMemberId: 'admin',
    }
    await (reader === 'roster' ? roster : publicDirectory).read(async () => publicAnswer)

    expect(requireHere(pool.row('member', active.id))).toEqual({ ...active, ...refreshed })
    expect(directory.members[0]).toBe(model)
    expect(roster.members[0]).toBe(model)
    expect(model?.displayName).toBe('Renamed')
    expect(model?.role).toBe('admin')
    expect(requireHere(pool.row('member', disabled.id))).toEqual(disabled)
    expect(directory.members.map((member) => member.id)).toEqual(['active', 'disabled'])
    expect(directory.actionsFor(active.id)).toEqual(['setRole'])
    expect(roster.nameOf(disabled.id)).toBeUndefined()
  } finally {
    directory.dispose()
    publicDirectory.dispose()
    pool.dispose()
  }
})

test('leaving the active roster keeps the member in an open admin list', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const directory = new MemberDirectory(pool)
  const roster = memberRoster(pool)
  const active = fullMember('active')
  const departing = fullMember('departing')
  try {
    await directory.read(async () => adminAnswer([active, departing]))
    const model = directory.members[1]
    await roster.read(async () => ({ members: [active], currentMemberId: 'admin' }))

    expect(directory.members[1]).toBe(model)
    expect(requireHere(pool.row('member', departing.id))).toEqual(departing)
    expect(roster.members.map((member) => member.id)).toEqual(['active'])
    expect(roster.shared).toBe(false)
    expect(roster.nameOf(departing.id)).toBeUndefined()

    // Only a full admin list is authoritative about record removal and
    // optional fields that have been cleared since its previous answer.
    const cleared: MemberView = {
      id: active.id,
      displayName: 'Active',
      role: 'member',
      email: null,
    }
    await directory.read(async () => adminAnswer([cleared]))
    expect(directory.members[0]).toBe(requireHere(pool.model('member', active.id)))
    expect(requireHere(pool.row('member', active.id))).toEqual(cleared)
    expect(isGone(pool.model('member', departing.id))).toBe(true)
  } finally {
    directory.dispose()
    pool.dispose()
  }
})

test('a member-readable directory exposes names and roles with no admin authority or invites', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const directory = new MemberDirectory(pool)
  await directory.read(async () => ({
    members: [{ id: 'alice', displayName: 'Alice', role: 'member' as const }],
    currentMemberId: 'alice',
  }))
  expect(directory.members.map((member) => [member.displayName, member.role])).toEqual([
    ['Alice', 'member'],
  ])
  expect(directory.invites).toEqual([])
  expect(directory.mailAvailable).toBe(false)
  expect(directory.hasOwnCredential).toBe(false)
  expect(directory.actionsFor('alice')).toEqual([])
  expect(memberRoster(pool).nameOf('alice')).toBe('Alice')
  directory.dispose()
  pool.dispose()
})

test('an admin directory supplies active roster names without losing full member fields', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const directory = new MemberDirectory(pool)
  const member = (id: string, disabledAt: string | null) => ({
    id,
    displayName: id,
    role: 'member',
    email: `${id}@example.com`,
    disabledAt,
  })
  await directory.read(
    async () =>
      ({
        members: [member('active', null), member('disabled', '2026-01-01')],
        currentMemberId: 'admin',
        invites: [],
        mailAvailable: true,
        hasOwnCredential: true,
        actions: { active: ['setRole'] },
      }) as MemberDirectoryAnswer,
  )
  const roster = memberRoster(pool)
  expect(roster.members.map((member) => member.id)).toEqual(['active'])
  expect(directory.members.map((member) => member.email)).toEqual([
    'active@example.com',
    'disabled@example.com',
  ])
  expect(directory.actionsFor('active')).toEqual(['setRole'])
  directory.dispose()
  pool.dispose()
})
