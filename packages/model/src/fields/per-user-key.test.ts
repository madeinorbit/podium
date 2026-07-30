/**
 * ONE SPELLING OF THE USER HALF (POD-365, extended by POD-418).
 *
 * The fragment's whole value is that `userId` has one definition and one
 * position. A second `z.object({ userId: UserIdField, … })` written somewhere
 * else is deep-equal, parses identically and is byte-identical on the wire — so
 * only object IDENTITY can see the fork (POD-305). These assertions are `toBe`
 * for that reason, and they are per composer rather than on the first one.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { UserIdField } from '../ids'
import { PersonalPreferences } from '../settings/preferences'
import { PinState, SessionSnoozeState, TabOrderState } from '../user-state/session-state'
import { perUserKey, PerUserKey, PerUserSingletonKey } from './per-user-key'

describe('every composer names the SAME `userId` schema instance', () => {
  const COMPOSERS: readonly [string, z.AnyZodObject][] = [
    ['PerUserSingletonKey', PerUserSingletonKey],
    ['PerUserKey', PerUserKey],
    ['perUserKey(z.string())', perUserKey(z.string())],
    ['SessionSnoozeState', SessionSnoozeState],
    ['PinState', PinState],
    ['TabOrderState', TabOrderState],
    ['PersonalPreferences', PersonalPreferences],
  ]

  for (const [name, schema] of COMPOSERS) {
    it(`${name} composes the shared user half`, () => {
      expect(schema.shape.userId).toBe(UserIdField)
    })
  }

  it('DETECTS a restated user half — proving identity is what is being checked', () => {
    // The can-say-NO probe. A hand-written twin passes every structural and
    // parse-level check; this is the assertion that does not.
    const restated = z.object({ userId: UserIdField.describe('a copy') })
    expect(restated.shape.userId).not.toBe(UserIdField)
  })
})

describe('the entity-keyed fragment EXTENDS the singleton one', () => {
  it('adds exactly `entityId`', () => {
    expect(Object.keys(PerUserSingletonKey.shape)).toEqual(['userId'])
    expect(Object.keys(perUserKey(z.string()).shape)).toEqual(['userId', 'entityId'])
  })

  it('keeps the entity half BRANDED per caller', () => {
    // A factory rather than a fixed `entityId: string` is the point: two callers
    // produce two shapes that cannot be mixed up.
    const branded = z.string().brand<'Thing'>()
    expect(perUserKey(branded).shape.entityId).toBe(branded)
  })

  it('keys a per-user SINGLETON by the person alone — no sentinel entity', () => {
    // POD-418's case: preference keys are about the person and about nothing
    // else, so inventing `entityId: 'settings'` would be a sentinel standing in
    // for a dimension that does not exist.
    expect(Object.keys(PersonalPreferences.shape)).not.toContain('entityId')
    expect(Object.keys(PersonalPreferences.shape)[0]).toBe('userId')
  })
})
