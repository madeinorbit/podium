import { expect, test } from 'vitest'
import { MemberDirectory, type MemberDirectoryAnswer } from './member-directory'
import { memberRoster } from './member-roster'
import { MobxPool } from './pool'

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
