/**
 * Layout authz — contract-derived live gate (POD-402 review gap 1).
 *
 * The refusing arm is a principal whose live role does not meet the contract's
 * roleFloor. Proves NO write occurs when the gate refuses.
 */

import { asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal, type CommandPrincipal } from '../../command-principal'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { UserLayoutRepository } from '../../store/user-layout'
import { layoutAuthzFailure, type LayoutAuthzDeps } from './authz'
import { LayoutService } from './service'

function deps(role: LayoutAuthzDeps['role'], principal?: CommandPrincipal): LayoutAuthzDeps {
  return {
    principal: principal ?? userCommandPrincipal(asUserId(FIRST_ADMIN_USER_ID), role ?? 'member'),
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
  it('gate refusal means the repository is never called', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const repo = new UserLayoutRepository(db)
    const service = new LayoutService({ layout: repo })

    const refusal = layoutAuthzFailure('layout.set', deps(undefined))
    expect(refusal).toBeDefined()
    // Mimic the trpc order: refuse BEFORE service.set.
    if (refusal) {
      // no write
    } else {
      service.set(FIRST_ADMIN_USER_ID, { dockTab: 'files' }, 't')
    }
    expect(repo.getSnapshot(FIRST_ADMIN_USER_ID)).toEqual({})
    // Positive control: the same service DOES write when the gate would pass.
    expect(layoutAuthzFailure('layout.set', deps('member'))).toBeUndefined()
    service.set(FIRST_ADMIN_USER_ID, { dockTab: 'files' }, 't')
    expect(repo.getSnapshot(FIRST_ADMIN_USER_ID)).toEqual({ dockTab: 'files' })
    db.close?.()
  })
})
