/**
 * UserLayoutRepository — per-user scoping and closed vocabulary (POD-1350).
 */

import { Database } from 'bun:sqlite'
import { FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserLayoutRepository } from './user-layout'

const ALICE = 'user:alice' as UserId
const BOB = 'user:bob' as UserId

function openDb(): Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE user_layout (
      user_id text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT user_layout_pk PRIMARY KEY (user_id, key)
    );
  `)
  return db
}

describe('UserLayoutRepository', () => {
  let db: Database
  let layout: UserLayoutRepository

  beforeEach(() => {
    db = openDb()
    layout = new UserLayoutRepository(db as never)
  })
  afterEach(() => db.close())

  it('writes and reads a snapshot for one user only', () => {
    layout.set(ALICE, 'dockTab', 'files', '2026-01-01T00:00:00.000Z')
    layout.set(ALICE, 'superOpen', true, '2026-01-01T00:00:00.000Z')
    layout.set(BOB, 'dockTab', 'shell', '2026-01-01T00:00:00.000Z')

    expect(layout.getSnapshot(ALICE)).toEqual({ dockTab: 'files', superOpen: true })
    expect(layout.getSnapshot(BOB)).toEqual({ dockTab: 'shell' })
    expect(layout.get(ALICE, 'dockTab')).toBe('files')
    expect(layout.get(BOB, 'superOpen')).toBeUndefined()
  })

  it('setMany is atomic on the closed set and refuses a free-form key', () => {
    expect(() =>
      layout.setMany(ALICE, { dockTab: 'mail', 'not.a.key': 1 }, '2026-01-01T00:00:00.000Z'),
    ).toThrow(/not a replicated layout key/)
    expect(layout.getSnapshot(ALICE)).toEqual({})

    layout.setMany(
      ALICE,
      { dockTab: 'mail', 'sidebar.section.closed': true },
      '2026-01-01T00:00:00.000Z',
    )
    expect(layout.getSnapshot(ALICE)).toEqual({
      dockTab: 'mail',
      'sidebar.section.closed': true,
    })
  })

  it('clear deletes the row so absence means never set', () => {
    layout.set(FIRST_ADMIN_USER_ID, 'panelMode', { s1: 'chat' }, '2026-01-01T00:00:00.000Z')
    layout.clear(FIRST_ADMIN_USER_ID, 'panelMode')
    expect(layout.get(FIRST_ADMIN_USER_ID, 'panelMode')).toBeUndefined()
    expect(layout.keysFor(FIRST_ADMIN_USER_ID)).toEqual([])
  })

  it('refuses device-local keys that must stay on the client', () => {
    expect(() => layout.set(ALICE, 'view', 'workspace', 't')).toThrow(/not a replicated/)
    expect(() => layout.set(ALICE, 'podium.view', 'workspace', 't')).toThrow(/not a replicated/)
  })
})
