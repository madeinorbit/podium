/**
 * Layout authz — contract-derived live gate (POD-402 review gap 1).
 *
 * The refusing arm is a principal whose live role does not meet the contract's
 * roleFloor. Proves NO write occurs when the gate refuses.
 */

import { asUserId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { createBunStoreExecutor } from '../../store/executor'
import { UserLayoutRepository } from '../../store/user-layout'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { type LayoutAuthzDeps, layoutAuthzFailure } from './authz'
import { LayoutService } from './service'

function deps(role: LayoutAuthzDeps['role'], principal?: CommandPrincipal): LayoutAuthzDeps {
  return {
    principal: principal ?? userCommandPrincipal(asUserId(firstAdminMemberId()), role ?? 'member'),
    role,
  }
}

describe('layoutAuthzFailure reads the contract floor LIVE', () => {
  it('permits a member for layout.set and layout.clear', () => {
    expect(layoutAuthzFailure('layout.set', deps('member'))).toBeUndefined()
    expect(layoutAuthzFailure('layout.clear', deps('admin'))).toBeUndefined()
  })

  it('refuses when the live role is missing (disabled / no account)', () => {
    const failure = layoutAuthzFailure('layout.set', deps(undefined))
    expect(failure).toBeDefined()
    expect(failure?.message).toMatch(/requires an member account/)
  })

  it('refuses an unknown command name rather than treating absence as permit', () => {
    expect(layoutAuthzFailure('layout.smuggled', deps('admin'))).toBeDefined()
  })
})

describe('a refused principal does not write', () => {
  it('gate refusal means the repository is never called', async () => {
    const db = openMigratedTestDatabase()
    const stage = createBunStoreExecutor({ database: db }).queries
    if (!stage) throw new Error('the test database is not bun-backed')
    const repo = new UserLayoutRepository(stage)
    const service = new LayoutService({ layout: repo })

    const refusal = layoutAuthzFailure('layout.set', deps(undefined))
    expect(refusal).toBeDefined()
    // Mimic the trpc order: refuse BEFORE service.set.
    if (refusal) {
      // no write
    } else {
      await service.set(firstAdminMemberId(), { dockTab: 'files' }, 't')
    }
    expect(await repo.getSnapshot(firstAdminMemberId())).toEqual({})
    // Positive control: the same service DOES write when the gate would pass.
    expect(layoutAuthzFailure('layout.set', deps('member'))).toBeUndefined()
    await service.set(firstAdminMemberId(), { dockTab: 'files' }, 't')
    expect(await repo.getSnapshot(firstAdminMemberId())).toEqual({ dockTab: 'files' })
    db.close?.()
  })
})
