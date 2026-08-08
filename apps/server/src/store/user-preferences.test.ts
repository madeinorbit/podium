/**
 * ONE USER'S PREFERENCES ARE NEVER ANOTHER USER'S (POD-1213; POD-352 AC3's "one
 * user's preference row is never visible to another").
 *
 * This is the file that would have caught the defect the issue exists to fix. It
 * is written against the REAL repository over a REAL migrated database — not a
 * fake — because the property under test is a WHERE clause and a fake would have
 * to re-implement it, then agree with itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THESE ASSERTIONS ABLE TO SAY NO
 * ---------------------------------------------------------------------------
 *
 * A cross-user test passes trivially if the second user simply has nothing. So
 * every isolation case below seeds BOTH users with DIFFERENT non-default values
 * at the SAME path and asserts each one gets their OWN — an assertion that fails
 * on a dropped `user_id` filter (both would read the same row) and also on a
 * resolver that ignored per-user rows entirely (both would read the blob).
 *
 * The suite also pins the FALLBACK direction, because a per-user store that
 * shadowed the deployment's instance settings would be a different bug with the
 * same shape: a leaf nobody has set must still resolve, and an instance-tier leaf
 * must resolve identically for everybody.
 */

import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { SettingsRepository } from './settings'

/** The second person. POD-315 mints real accounts; the storage is keyed for them
 *  NOW, which is exactly why a second id can be written today and must not be
 *  visible to the first. */
const ALICE: UserId = FIRST_ADMIN_USER_ID
const BOB: UserId = asUserId('user:bob')

const AT = '2026-07-31T04:00:00.000Z'

let settings: SettingsRepository
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  db = openMigratedTestDatabase()
  settings = new SettingsRepository(db)
})

describe('a preference row belongs to one person', () => {
  it('two people hold DIFFERENT values at the same path, and each reads their own', () => {
    settings.userPreferences.set(ALICE, 'roles.coding.model', 'alice-model', AT)
    settings.userPreferences.set(BOB, 'roles.coding.model', 'bob-model', AT)

    // The load-bearing pair. Removing the `user_id` filter from either read
    // makes these two assertions read one row and disagree with one of them.
    expect(settings.getSettingsFor(ALICE).roles.coding.model).toBe('alice-model')
    expect(settings.getSettingsFor(BOB).roles.coding.model).toBe('bob-model')
  })

  it("a person who has set NOTHING does not inherit the other person's choice", () => {
    // The leak, stated directly: Alice configures her notification routing, and Bob —
    // who has never opened the settings screen — must not be served it.
    settings.userPreferences.set(ALICE, 'notifications.ntfyTopic', 'alice-secret-topic', AT)
    settings.userPreferences.set(ALICE, 'notifications.telegramChatId', '-100alice', AT)

    const bob = settings.getSettingsFor(BOB)
    expect(bob.notifications.ntfyTopic).toBe('')
    expect(bob.notifications.telegramChatId).toBe('')
    // …and Alice still has hers, so this is not passing because nothing was
    // stored at all.
    expect(settings.getSettingsFor(ALICE).notifications.ntfyTopic).toBe('alice-secret-topic')
  })

  it('the SINGLE-KEY read is scoped too, not just the bulk one', () => {
    // Found by mutation: dropping `user_id` from `get(userId, key)` alone left
    // every other case in this file green, because they all resolve through the
    // bulk read. `preferenceFor` goes through THIS method, so an unscoped
    // single-key read is the same leak reached by a different door.
    settings.userPreferences.set(ALICE, 'notifications.telegramChatId', '-100alice', AT)
    settings.userPreferences.set(BOB, 'notifications.telegramChatId', '-100bob', AT)
    expect(settings.userPreferences.get(ALICE, 'notifications.telegramChatId')).toBe('-100alice')
    expect(settings.userPreferences.get(BOB, 'notifications.telegramChatId')).toBe('-100bob')

    // …and a person with NO row reads absent even while someone else has one —
    // the direction that fails when the filter is gone and the other person's
    // row is the only one in the table.
    settings.userPreferences.set(ALICE, 'roles.superagent.model', 'alice-superagent', AT)
    expect(settings.userPreferences.get(BOB, 'roles.superagent.model')).toBeUndefined()
    expect(settings.preferenceFor(BOB, 'roles.superagent.model')).toBe('auto')
    expect(settings.preferenceFor(ALICE, 'roles.superagent.model')).toBe('alice-superagent')
  })

  it('a write for one person creates no row for the other', () => {
    settings.userPreferences.set(ALICE, 'sidebar.repoSort', 'alphabetical', AT)
    expect(settings.userPreferences.keysFor(ALICE)).toEqual(['sidebar.repoSort'])
    expect(settings.userPreferences.keysFor(BOB)).toEqual([])
  })

  it('a whole-blob save by one person does not write the other person’s view', () => {
    // `settings.set` is the legacy write every shipped client still uses: it
    // posts the WHOLE object back. Before this issue that object landed on the
    // shared row, which is how one person's save became everybody's settings.
    const alice = settings.getSettingsFor(ALICE)
    settings.setSettingsFor(
      ALICE,
      normalizeSettings({
        ...alice,
        sidebar: { ...alice.sidebar, repoSort: 'alphabetical', groupByRepo: true },
        autoContinue: { ...alice.autoContinue, enabled: true },
      }),
      AT,
    )

    const bob = settings.getSettingsFor(BOB)
    expect(bob.sidebar.repoSort).toBe('lastUsed')
    expect(bob.sidebar.groupByRepo).toBe(false)
    expect(bob.autoContinue.enabled).toBe(false)
    expect(settings.getSettingsFor(ALICE).sidebar.repoSort).toBe('alphabetical')
  })
})

describe('the instance tier stays shared — this moved 24 leaves, not the blob', () => {
  it("one person's instance-tier write IS the deployment's answer for everybody", () => {
    const alice = settings.getSettingsFor(ALICE)
    settings.setSettingsFor(
      ALICE,
      normalizeSettings({
        ...alice,
        gitWorkflow: { ...alice.gitWorkflow, mergeStyle: 'pr' },
        hibernation: { ...alice.hibernation, memoryPct: 61 },
      }),
      AT,
    )

    // The counter-property to every isolation case above. A storage move that
    // made ALL settings per-user would pass this file's first describe block and
    // give one repo two merge styles, which is the thing `preferences-instance`
    // exists to prevent.
    expect(settings.getSettingsFor(BOB).gitWorkflow.mergeStyle).toBe('pr')
    expect(settings.getSettingsFor(BOB).hibernation.memoryPct).toBe(61)
    expect(settings.getSettings().gitWorkflow.mergeStyle).toBe('pr')
  })

  it('an instance-tier leaf never becomes a per-user row', () => {
    settings.applyPreferencePatch(ALICE, { 'gitWorkflow.mergeStyle': 'ask' }, AT)
    expect(settings.userPreferences.keysFor(ALICE)).toEqual([])
    expect(settings.getSettings().gitWorkflow.mergeStyle).toBe('ask')
  })

  it('the repository REFUSES a per-user row for a key that is not personal', () => {
    // The refusal that keeps the two homes from both holding one key. A silent
    // ignore would make a mis-tiered write look identical to a successful one.
    expect(() => settings.userPreferences.set(ALICE, 'gitWorkflow.mergeStyle', 'pr', AT)).toThrow(
      /not a personal preference/,
    )
    expect(() => settings.userPreferences.set(ALICE, 'apiKeys.openai', 'sk-x', AT)).toThrow(
      /not a personal preference/,
    )
    // …and it ACCEPTS a personal one, or the refusal above would be satisfied by
    // a method that refuses everything.
    expect(() =>
      settings.userPreferences.set(ALICE, 'sidebar.repoSort', 'custom', AT),
    ).not.toThrow()
  })
})

describe('absence is the row being absent', () => {
  it('an unset preference resolves to the blob’s value, and a set one overrides it', () => {
    // The fallback direction. `getSettingsFor` must not zero out what nobody has
    // chosen — that would be a different way to lose every preference.
    expect(settings.getSettingsFor(ALICE).sidebar.repoSort).toBe('lastUsed')
    settings.userPreferences.set(ALICE, 'sidebar.repoSort', 'custom', AT)
    expect(settings.getSettingsFor(ALICE).sidebar.repoSort).toBe('custom')
  })

  it('clearing a preference restores the fallback rather than storing a default', () => {
    settings.userPreferences.set(ALICE, 'sidebar.repoSort', 'custom', AT)
    settings.userPreferences.clear(ALICE, 'sidebar.repoSort')
    expect(settings.userPreferences.keysFor(ALICE)).toEqual([])
    expect(settings.getSettingsFor(ALICE).sidebar.repoSort).toBe('lastUsed')
  })

  it('a value JSON cannot parse reads as absent, not as a crash', () => {
    // A corrupt row must not make one person's whole settings screen fail to
    // load — the posture `getSettings` already takes for a corrupt blob. Written
    // through the raw database because the repository cannot produce one, which
    // is the point: the row can only arrive from an older build or a hand edit.
    db.prepare(
      'INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
    ).run(ALICE, 'sidebar.repoSort', 'not json', AT)
    settings.userPreferences.set(ALICE, 'notifications.ntfyTopic', 'still-mine', AT)

    // The unparseable leaf falls back; the person's OTHER preferences still
    // resolve, so one bad row does not cost them the rest.
    expect(settings.getSettingsFor(ALICE).sidebar.repoSort).toBe('lastUsed')
    expect(settings.getSettingsFor(ALICE).notifications.ntfyTopic).toBe('still-mine')
    expect(settings.userPreferences.get(ALICE, 'sidebar.repoSort')).toBeUndefined()
  })

  it('JSON types survive the round trip — a boolean is not a 1', () => {
    settings.userPreferences.set(ALICE, 'autoContinue.enabled', true, AT)
    settings.userPreferences.set(ALICE, 'sidebar.repoOrder', ['/a', '/b'], AT)
    expect(settings.userPreferences.get(ALICE, 'autoContinue.enabled')).toBe(true)
    expect(settings.getSettingsFor(ALICE).sidebar.repoOrder).toEqual(['/a', '/b'])
  })
})
