/**
 * LayoutService — principal-scoped snapshot writes (POD-1350).
 */

import { Database } from 'bun:sqlite'
import { type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserLayoutRepository } from '../../store/user-layout'
import { LayoutService } from './service'

const ALICE = 'user:alice' as UserId
const BOB = 'user:bob' as UserId

describe('LayoutService', () => {
  let db: Database
  let service: LayoutService

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE user_layout (
        user_id text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `)
    service = new LayoutService(new UserLayoutRepository(db as never))
  })
  afterEach(() => db.close())

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
