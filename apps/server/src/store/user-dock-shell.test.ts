/**
 * UserDockShellRepository — server-owned worktree→shell mapping (POD-4436).
 *
 * Per user, per normalized worktree path → session id. The `(user_id,
 * worktree_key)` primary key arbitrates creation: two devices opening the same
 * worktree at once must not create two shells.
 */

import { asSessionId, asUserId, firstAdminMemberId, type SessionId, type UserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { UserDockShellRepository } from './user-layout'

const ALICE: UserId = firstAdminMemberId()
const BOB: UserId = asUserId('user:bob')
const AT = '2026-09-22T00:00:00.000Z'

const SHELL_A = asSessionId('11111111-1111-4111-8111-111111111111')
const SHELL_B = asSessionId('22222222-2222-4222-8222-222222222222')

let shells: UserDockShellRepository

beforeEach(() => {
  const db = openMigratedTestDatabase()
  const stage = createBunStoreExecutor({ database: db }).queries
  if (!stage) throw new Error('the test database is not bun-backed')
  shells = new UserDockShellRepository(stage)
})

describe('UserDockShellRepository', () => {
  it('writes and reads one shell per worktree per user', async () => {
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBeUndefined()
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_A, AT)
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBe(SHELL_A)
    // Other user and other worktree are isolated.
    expect(await shells.get(BOB, '/repo/.worktrees/a')).toBeUndefined()
    expect(await shells.get(ALICE, '/repo/.worktrees/b')).toBeUndefined()
    await shells.remove(ALICE, '/repo/.worktrees/a')
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBeUndefined()
  })

  it('normalizes trailing slashes to one row', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a/', SHELL_A, AT)
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBe(SHELL_A)
    expect(await shells.get(ALICE, '/repo/.worktrees/a/')).toBe(SHELL_A)
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_B, AT)
    expect(await shells.get(ALICE, '/repo/.worktrees/a/')).toBe(SHELL_B)
  })

  it('tryClaim arbitrates: loser keeps the winner row and never overwrites', async () => {
    expect(await shells.tryClaim(ALICE, '/repo/.worktrees/a', SHELL_A, AT)).toBe(true)
    expect(await shells.tryClaim(ALICE, '/repo/.worktrees/a', SHELL_B, AT)).toBe(false)
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBe(SHELL_A)
  })

  it('set replaces a dead shell row', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_A, AT)
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_B, AT)
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBe(SHELL_B)
  })

  it('removeByWorktree frees every user row for the path and returns the sessions', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_A, AT)
    await shells.set(BOB, '/repo/.worktrees/a/', SHELL_B, AT)
    await shells.set(ALICE, '/repo/.worktrees/b', SHELL_B, AT)
    const freed = await shells.removeByWorktree('/repo/.worktrees/a')
    expect(new Set(freed)).toEqual(new Set([SHELL_A, SHELL_B]))
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBeUndefined()
    expect(await shells.get(BOB, '/repo/.worktrees/a')).toBeUndefined()
    // Unrelated worktree survives.
    expect(await shells.get(ALICE, '/repo/.worktrees/b')).toBe(SHELL_B)
  })

  it('removeBySession retires every mapping pointing at the shell', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_A, AT)
    await shells.set(BOB, '/repo/.worktrees/b', SHELL_A, AT)
    await shells.removeBySession(SHELL_A)
    expect(await shells.get(ALICE, '/repo/.worktrees/a')).toBeUndefined()
    expect(await shells.get(BOB, '/repo/.worktrees/b')).toBeUndefined()
  })

  it('refuses a relative path on write and reads it as absent', async () => {
    expect(await shells.get(ALICE, 'relative/path')).toBeUndefined()
    await expect(shells.set(ALICE, 'relative/path', SHELL_A, AT)).rejects.toThrow(
      /not an absolute worktree path/,
    )
    await expect(
      shells.tryClaim(ALICE, 'relative/path', SHELL_A as SessionId, AT),
    ).rejects.toThrow(/not an absolute worktree path/)
  })

  it('listForUser returns the normalized map', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a/', SHELL_A, AT)
    await shells.set(ALICE, '/repo/.worktrees/b', SHELL_B, AT)
    expect(await shells.listForUser(ALICE)).toEqual({
      '/repo/.worktrees/a': SHELL_A,
      '/repo/.worktrees/b': SHELL_B,
    })
    expect(await shells.listForUser(BOB)).toEqual({})
  })

  it('worktreesForSessions answers every shell in one read, row for row with worktreeForSession', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_A, AT)
    await shells.set(BOB, '/repo/.worktrees/b', SHELL_A, AT)
    await shells.set(ALICE, '/repo/.worktrees/c', SHELL_B, AT)
    const UNMAPPED = asSessionId('33333333-3333-4333-8333-333333333333')
    const batched = await shells.worktreesForSessions([SHELL_A, SHELL_B, UNMAPPED, SHELL_A])
    expect(batched.get(SHELL_A)).toEqual(await shells.worktreeForSession(SHELL_A))
    expect(batched.get(SHELL_B)).toEqual(await shells.worktreeForSession(SHELL_B))
    expect(batched.has(UNMAPPED)).toBe(false)
    expect((await shells.worktreesForSessions([])).size).toBe(0)
  })

  it('worktreesForSessions chunks past the SQLite variable limit', async () => {
    const ids = Array.from({ length: 1200 }, (_, i) =>
      asSessionId(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))
    for (const [i, id] of ids.entries()) await shells.set(ALICE, `/repo/.worktrees/w${i}`, id, AT)
    const batched = await shells.worktreesForSessions(ids)
    expect(batched.size).toBe(1200)
    expect(batched.get(ids[1199]!)).toEqual([{ userId: ALICE, worktreeKey: '/repo/.worktrees/w1199' }])
  })

  it('worktreeForSession resolves the owning rows for a shell (step 3 reverse lookup)', async () => {
    await shells.set(ALICE, '/repo/.worktrees/a', SHELL_A, AT)
    expect(await shells.worktreeForSession(SHELL_A)).toEqual([
      { userId: ALICE, worktreeKey: '/repo/.worktrees/a' },
    ])
    expect(await shells.worktreeForSession(SHELL_B)).toEqual([])
    await shells.removeBySession(SHELL_A)
    expect(await shells.worktreeForSession(SHELL_A)).toEqual([])
  })
})
