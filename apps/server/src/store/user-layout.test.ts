/**
 * UserLayoutRepository — per-user scoping and closed vocabulary (POD-1350).
 */

import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import { UserLayoutRepository } from './user-layout'

const ALICE: UserId = FIRST_ADMIN_USER_ID
const BOB: UserId = asUserId('user:bob')
const AT = '2026-08-02T09:00:00.000Z'

let layout: UserLayoutRepository

beforeEach(() => {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  layout = new UserLayoutRepository(db)
})

describe('UserLayoutRepository', () => {
  it('writes and reads a snapshot for one user only', () => {
    layout.set(ALICE, 'dockTab', 'files', AT)
    layout.set(ALICE, 'superOpen', true, AT)
    layout.set(BOB, 'dockTab', 'shell', AT)

    expect(layout.getSnapshot(ALICE)).toEqual({ dockTab: 'files', superOpen: true })
    expect(layout.getSnapshot(BOB)).toEqual({ dockTab: 'shell' })
    expect(layout.get(ALICE, 'dockTab')).toBe('files')
    expect(layout.get(BOB, 'superOpen')).toBeUndefined()
  })

  it('setMany is atomic on the closed set and refuses a free-form key', () => {
    expect(() =>
      layout.setMany(ALICE, { dockTab: 'mail', 'not.a.key': 1 }, AT),
    ).toThrow(/not a replicated layout key/)
    expect(layout.getSnapshot(ALICE)).toEqual({})

    layout.setMany(ALICE, { dockTab: 'mail', 'sidebar.section.closed': true }, AT)
    expect(layout.getSnapshot(ALICE)).toEqual({
      dockTab: 'mail',
      'sidebar.section.closed': true,
    })
  })

  it('clear deletes the row so absence means never set', () => {
    layout.set(FIRST_ADMIN_USER_ID, 'panelMode', { s1: 'chat' }, AT)
    layout.clear(FIRST_ADMIN_USER_ID, 'panelMode')
    expect(layout.get(FIRST_ADMIN_USER_ID, 'panelMode')).toBeUndefined()
    expect(layout.keysFor(FIRST_ADMIN_USER_ID)).toEqual([])
  })

  it('refuses device-local keys that must stay on the client', () => {
    expect(() => layout.set(ALICE, 'view', 'workspace', AT)).toThrow(/not a replicated/)
    expect(() => layout.set(ALICE, 'podium.view', 'workspace', AT)).toThrow(/not a replicated/)
  })
})
