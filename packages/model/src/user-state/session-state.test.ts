/**
 * The per-user family's shape properties (POD-380 seeding POD-1076's home).
 *
 * The load-bearing assertion is the COMPOSITION one: a member built from a fresh
 * `z.object({ userId: z.string(), entityId: ... })` would parse identically and
 * encode identically, so only asserting the field IS the shared fragment's field
 * catches a fork. This is the branding-is-compile-time blind spot restated for the
 * key fragment.
 */

import { describe, expect, it } from 'vitest'
import { PerUserKey, perUserKey, userEntityKey } from '../fields/per-user-key'
import { SessionIdField, UserIdField } from '../ids'
import {
  PinState,
  POD380_USER_STATE_MEMBERS,
  SessionSnoozeState,
  TabOrderState,
} from './session-state'

describe('every member composes the ONE (userId, entityId) fragment', () => {
  it.each(POD380_USER_STATE_MEMBERS)('$name keys on userId + entityId', ({ schema }) => {
    expect(Object.keys(schema.shape).slice(0, 2)).toEqual(['userId', 'entityId'])
  })

  it('the userId field is the SHARED instance, not a same-shaped copy', () => {
    // `toBe`, not a parse comparison: a fresh z.string().brand<'UserId'>() would
    // pass every value-level check while forking the definition — the drift a
    // golden wire test is structurally blind to.
    const shared = PerUserKey.shape.userId
    for (const { name, schema } of POD380_USER_STATE_MEMBERS) {
      expect(schema.shape.userId, name).toBe(shared)
    }
  })

  it('the branded members keep the entity brand; the path-keyed ones decline it explicitly', () => {
    // Snooze is about a SESSION, so its entity half is the branded field instance.
    expect(SessionSnoozeState.shape.entityId).toBe(SessionIdField)
    // Pins and tab order are keyed by a path or a multi-kind id, so they cannot be
    // branded — but they must still refuse a non-string, or "unbranded" would have
    // quietly become "unvalidated".
    expect(PinState.shape.entityId.safeParse('/repo/a').success).toBe(true)
    expect(PinState.shape.entityId.safeParse(42).success).toBe(false)
    expect(TabOrderState.shape.entityId.safeParse(42).success).toBe(false)
  })

  it('no member carries a `visibility` field — the class is a matrix annotation, never a per-row value', () => {
    // ADR 9 D3: per-user state is non-grantable BY CONSTRUCTION. A row-level
    // visibility field would be a value a writer could set wrong.
    for (const { name, schema } of POD380_USER_STATE_MEMBERS) {
      expect(Object.keys(schema.shape), name).not.toContain('visibility')
      expect(Object.keys(schema.shape), name).not.toContain('grants')
    }
  })
})

describe('the members’ own semantics', () => {
  it('snooze distinguishes until-next-message (null) from not-snoozed (no row)', () => {
    const key = { userId: 'u1', entityId: 's1' }
    expect(SessionSnoozeState.safeParse({ ...key, snoozedUntil: null }).success).toBe(true)
    expect(
      SessionSnoozeState.safeParse({ ...key, snoozedUntil: '2030-01-01T00:00:00.000Z' }).success,
    ).toBe(true)
    // `undefined` is not a representable snooze value: absence is the absent ROW,
    // not a row with an absent field.
    expect(SessionSnoozeState.safeParse({ ...key }).success).toBe(false)
  })

  it('a pin declares which kind of thing it points at, from a closed set', () => {
    const base = { userId: 'u1', entityId: '/repo/a' }
    expect(PinState.safeParse({ ...base, kind: 'repo' }).success).toBe(true)
    expect(PinState.safeParse({ ...base, kind: 'session' }).success).toBe(false)
  })

  it('two users’ rows for the SAME entity are two distinct keys', () => {
    // The property the whole re-key exists for, at the key level: same entity,
    // different user, different row. If the encoding dropped the user half this
    // would collapse to one key and the test would fail.
    const u1 = UserIdField.parse('u1')
    const u2 = UserIdField.parse('u2')
    const sessionRef = { kind: 'session', id: SessionIdField.parse('s1') } as const
    expect(userEntityKey(u1, sessionRef)).not.toBe(userEntityKey(u2, sessionRef))
  })
})

describe('the fragment factory is reused, not re-implemented', () => {
  it('perUserKey(X) puts the user half in the same position for any entity brand', () => {
    expect(Object.keys(perUserKey(SessionIdField).shape)).toEqual(['userId', 'entityId'])
  })
})
