/**
 * UserLayoutRepository — per-user scoping and closed vocabulary (POD-1350).
 */

import { layoutSetInput } from '@podium/commands'
import { asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { UserLayoutRepository } from './user-layout'

const ALICE: UserId = firstAdminMemberId()
const BOB: UserId = asUserId('user:bob')
const AT = '2026-08-02T09:00:00.000Z'

let layout: UserLayoutRepository

beforeEach(() => {
  const db = openMigratedTestDatabase()
  const stage = createBunStoreExecutor({ database: db }).queries
  if (!stage) throw new Error('the test database is not bun-backed')
  layout = new UserLayoutRepository(stage)
})

describe('UserLayoutRepository', () => {
  it('accepts tip keys through the command schema and stores independent account rows', async () => {
    const values = {
      'tips.seen.first-prompt': AT,
      'tips.enabled': 'false',
    }
    expect(layoutSetInput.parse({ values })).toEqual({ values })
    await layout.setMany(fixtureWriteScope(), ALICE, values, AT)
    await layout.setMany(fixtureWriteScope(), ALICE, { 'tips.seen.first-send': AT }, AT)
    expect(await layout.getSnapshot(ALICE)).toEqual({ ...values, 'tips.seen.first-send': AT })
    expect(await layout.getSnapshot(BOB)).toEqual({})
  })

  it('reads every account row for the boot reconcile, a page at a time through the key', async () => {
    await layout.setMany(
      fixtureWriteScope(),
      ALICE,
      { dockTab: 'files', superOpen: true, 'tips.enabled': 'false' },
      AT,
    )
    await layout.setMany(fixtureWriteScope(), BOB, { dockTab: 'shell', superOpen: false }, AT)

    const whole = await layout.allForBootReconcile()
    expect(whole.filter((row) => row.userId === ALICE || row.userId === BOB)).toHaveLength(5)
    // Pages of two cross the user boundary mid-page and end on a partial page.
    expect(await layout.allForBootReconcile(2)).toEqual(whole)
    expect(await layout.allForBootReconcile(1)).toEqual(whole)
  })

  it('writes and reads a snapshot for one user only', async () => {
    await layout.set(fixtureWriteScope(), ALICE, 'dockTab', 'files', AT)
    await layout.set(fixtureWriteScope(), ALICE, 'superOpen', true, AT)
    await layout.set(fixtureWriteScope(), BOB, 'dockTab', 'shell', AT)

    expect(await layout.getSnapshot(ALICE)).toEqual({ dockTab: 'files', superOpen: true })
    expect(await layout.getSnapshot(BOB)).toEqual({ dockTab: 'shell' })
    expect(await layout.get(ALICE, 'dockTab')).toBe('files')
    expect(await layout.get(BOB, 'superOpen')).toBeUndefined()
  })

  it('setMany is atomic on the closed set and refuses a free-form key', async () => {
    await expect(
      layout.setMany(fixtureWriteScope(), ALICE, { dockTab: 'mail', 'not.a.key': 1 }, AT),
    ).rejects.toThrow(/not a replicated layout key/)
    expect(await layout.getSnapshot(ALICE)).toEqual({})

    await layout.setMany(
      fixtureWriteScope(),
      ALICE,
      { dockTab: 'mail', 'sidebar.section.closed': true },
      AT,
    )
    expect(await layout.getSnapshot(ALICE)).toEqual({
      dockTab: 'mail',
      'sidebar.section.closed': true,
    })
  })

  it('clear deletes the row so absence means never set', async () => {
    await layout.set(fixtureWriteScope(), firstAdminMemberId(), 'panelMode', { s1: 'chat' }, AT)
    await layout.clear(fixtureWriteScope(), firstAdminMemberId(), 'panelMode')
    expect(await layout.get(firstAdminMemberId(), 'panelMode')).toBeUndefined()
    expect(await layout.keysFor(firstAdminMemberId())).toEqual([])
  })

  it('refuses device-local keys that must stay on the client', async () => {
    await expect(layout.set(fixtureWriteScope(), ALICE, 'view', 'workspace', AT)).rejects.toThrow(
      /not a replicated/,
    )
    await expect(
      layout.set(fixtureWriteScope(), ALICE, 'podium.view', 'workspace', AT),
    ).rejects.toThrow(/not a replicated/)
  })
})
