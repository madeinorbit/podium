/**
 * Feed-cursor authz — the contract-derived live gate (POD-1380), plus the
 * property the whole family rests on: the row is keyed by the resolved
 * principal, and the input has no user field to key it by instead (ADR 3 D7).
 */

import { readPositionAdvanceInput } from '@podium/commands'
import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { UserReadPositionRepository } from '../../store/user-read-position'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { type ReadPositionAuthzDeps, readPositionActor, readPositionAuthzFailure } from './authz'
import { ReadPositionService } from './service'

const ALICE: UserId = FIRST_ADMIN_USER_ID
const BOB: UserId = asUserId('user:bob')

function deps(
  role: ReadPositionAuthzDeps['role'],
  principal?: CommandPrincipal,
): ReadPositionAuthzDeps {
  return {
    principal: principal ?? userCommandPrincipal(asUserId(ALICE), role ?? 'member'),
    role,
  }
}

describe('readPositionAuthzFailure reads the contract floor LIVE', () => {
  it('permits a member', () => {
    expect(readPositionAuthzFailure('readPosition.advance', deps('member'))).toBeUndefined()
    expect(readPositionAuthzFailure('readPosition.advance', deps('admin'))).toBeUndefined()
  })

  it('refuses when the live role is missing (disabled / no account)', () => {
    const failure = readPositionAuthzFailure('readPosition.advance', deps(undefined))
    expect(failure).toBeDefined()
    expect(failure?.message).toMatch(/requires an member account/)
  })

  it('refuses an unknown command name rather than treating absence as permit', () => {
    expect(readPositionAuthzFailure('readPosition.smuggled', deps('admin'))).toBeDefined()
  })
})

describe('the actor comes from the principal, and the input cannot supply one', () => {
  it('resolves the acting user from the capability, not the payload', () => {
    expect(readPositionActor(deps('member', userCommandPrincipal(BOB, 'member')))).toBe(BOB)
    expect(readPositionActor(deps('member', userCommandPrincipal(ALICE, 'member')))).toBe(ALICE)
  })

  it('a payload claiming a userId is STRIPPED, not merely refused', () => {
    // ADR 3 D7: a frame claiming to be from someone is inert. The command has no
    // user field at all, so a smuggled one does not survive parsing and there is
    // nothing downstream that could read it.
    const parsed = readPositionAdvanceInput.parse({
      streamId: 'issueEvents',
      lastEventId: 5,
      userId: BOB,
    })
    expect(Object.hasOwn(parsed, 'userId')).toBe(false)
  })

  it('refuses an unknown stream at the command boundary', () => {
    expect(
      readPositionAdvanceInput.safeParse({ streamId: 'notAStream', lastEventId: 1 }).success,
    ).toBe(false)
    expect(
      readPositionAdvanceInput.safeParse({ streamId: 'issueEvents', lastEventId: 1 }).success,
    ).toBe(true)
  })
})

describe('a refused principal does not write', () => {
  it('gate refusal means the repository is never called; the positive control writes', () => {
    const db = openMigratedTestDatabase()
    const repo = new UserReadPositionRepository(db)
    const service = new ReadPositionService({ cursors: repo })

    const refusal = readPositionAuthzFailure('readPosition.advance', deps(undefined))
    expect(refusal).toBeDefined()
    // Mimic the trpc order: refuse BEFORE the handler.
    if (!refusal) service.advance(ALICE, 'issueEvents', { lastEventId: 4, seenAt: null }, 't')
    expect(repo.getSnapshot(ALICE)).toEqual({})

    expect(readPositionAuthzFailure('readPosition.advance', deps('member'))).toBeUndefined()
    service.advance(ALICE, 'issueEvents', { lastEventId: 4, seenAt: null }, 't')
    expect(repo.getSnapshot(ALICE)).toEqual({ issueEvents: { lastEventId: 4, seenAt: null } })
    // …and it wrote for the ACTOR only.
    expect(repo.getSnapshot(BOB)).toEqual({})
    db.close?.()
  })
})
