/**
 * LayoutService — principal-scoped snapshot writes (POD-1350).
 */

import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { UserLayoutRepository } from '../../store/user-layout'
import { LayoutService } from './service'

const ALICE: UserId = FIRST_ADMIN_USER_ID
const BOB: UserId = asUserId('user:bob')

let service: LayoutService

beforeEach(() => {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  service = new LayoutService(new UserLayoutRepository(db))
})

describe('LayoutService', () => {
  it('set returns the full snapshot and does not leak across users', () => {
    const alice = service.set(ALICE, { dockTab: 'files', superOpen: true }, 't1')
    expect(alice).toEqual({ dockTab: 'files', superOpen: true })
    expect(service.getSnapshot(BOB)).toEqual({})

    service.set(BOB, { dockTab: 'shell' }, 't2')
    expect(service.getSnapshot(ALICE)).toEqual({ dockTab: 'files', superOpen: true })
    expect(service.getSnapshot(BOB)).toEqual({ dockTab: 'shell' })
  })

  it('clear removes keys and leaves the rest', () => {
    service.set(ALICE, { dockTab: 'files', superOpen: true }, 't1')
    expect(service.clear(ALICE, ['superOpen'])).toEqual({ dockTab: 'files' })
  })
})
