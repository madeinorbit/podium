/**
 * UserLayoutRepository — per-user scoping and closed vocabulary (POD-1350).
 */

import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { UserLayoutRepository } from './user-layout'

const ALICE: UserId = FIRST_ADMIN_USER_ID
const BOB: UserId = asUserId('user:bob')
const AT = '2026-08-02T09:00:00.000Z'

let layout: UserLayoutRepository

beforeEach(() => {
  const db = openMigratedTestDatabase()
  layout = new UserLayoutRepository(createBunStoreExecutor({ database: db }))
})

describe('UserLayoutRepository', () => {
  it('writes and reads a snapshot for one user only', async () => {
    await layout.set(ALICE, 'dockTab', 'files', AT)
    await layout.set(ALICE, 'superOpen', true, AT)
    await layout.set(BOB, 'dockTab', 'shell', AT)

    expect(await layout.getSnapshot(ALICE)).toEqual({ dockTab: 'files', superOpen: true })
    expect(await layout.getSnapshot(BOB)).toEqual({ dockTab: 'shell' })
    expect(await layout.get(ALICE, 'dockTab')).toBe('files')
    expect(await layout.get(BOB, 'superOpen')).toBeUndefined()
  })

  it('setMany is atomic on the closed set and refuses a free-form key', async () => {
    expect(() => layout.setMany(ALICE, { dockTab: 'mail', 'not.a.key': 1 }, AT)).toThrow(
      /not a replicated layout key/,
    )
    expect(await layout.getSnapshot(ALICE)).toEqual({})

    await layout.setMany(ALICE, { dockTab: 'mail', 'sidebar.section.closed': true }, AT)
    expect(await layout.getSnapshot(ALICE)).toEqual({
      dockTab: 'mail',
      'sidebar.section.closed': true,
    })
  })

  it('clear deletes the row so absence means never set', async () => {
    await layout.set(FIRST_ADMIN_USER_ID, 'panelMode', { s1: 'chat' }, AT)
    await layout.clear(FIRST_ADMIN_USER_ID, 'panelMode')
    expect(await layout.get(FIRST_ADMIN_USER_ID, 'panelMode')).toBeUndefined()
    expect(await layout.keysFor(FIRST_ADMIN_USER_ID)).toEqual([])
  })

  it('refuses device-local keys that must stay on the client', () => {
    expect(() => layout.set(ALICE, 'view', 'workspace', AT)).toThrow(/not a replicated/)
    expect(() => layout.set(ALICE, 'podium.view', 'workspace', AT)).toThrow(/not a replicated/)
  })
})
