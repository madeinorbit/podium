/**
 * The per-user family's shape properties (POD-380 seeded it; POD-1076 completed it).
 *
 * The load-bearing assertion is the COMPOSITION one: a member built from a fresh
 * `z.object({ userId: z.string(), entityId: ... })` would parse identically and
 * encode identically, so only asserting the field IS the shared fragment's field
 * catches a fork. This is the branding-is-compile-time blind spot restated for the
 * key fragment.
 *
 * Every `it.each` over the family runs a NON-VACUITY guard first (the family is
 * non-empty and has the size the inventory says). An `it.each([])` reports as a
 * clean pass, so a totality suite whose list silently shrank would be green about
 * members it stopped checking.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PerUserKey, perUserKey } from '../fields/per-user-key'
import { IssueIdField, SessionIdField, UserIdField } from '../ids'
import { userEntityKey } from '../ids/keys'
import { PER_USER_STATE_FAMILY, PER_USER_STATE_NON_MEMBERS } from './family'
import {
  IssueMessageReadState,
  IssueUserState,
  issueOverlayOf,
  NO_ISSUE_USER_STATE,
} from './issue-state'
import {
  DEVICE_LOCAL_UI_KEYS,
  isLayoutKey,
  layoutKeyFromLegacy,
  LayoutState,
  LAYOUT_EXACT_KEYS,
} from './layout-state'
import { PersonalPreferenceState } from './preference-state'
import {
  NO_SESSION_USER_STATE,
  PinState,
  SessionReadState,
  SessionSnoozeState,
  TabOrderState,
} from './session-state'

describe('the family list is the thing every totality assertion below reads', () => {
  it('covers inventory §7.1 completely: eight schemas plus one declared non-member', () => {
    // Eight + one = the nine distinct facts §7.1 enumerates once the three issue
    // markers are recognised as one key. If a member is ever dropped, this fails
    // BEFORE the it.each blocks below quietly stop checking it.
    //
    // The counts MOVED at POD-1213 (6 + 3 → 7 + 2) and again at POD-1350
    // (7 + 2 → 8 + 1): `sidebarAndTabLayout` was a declared non-member for as
    // long as layout lived only in client ui-state, and became a member when it
    // got `user_layout`. The pair is asserted together on purpose — a member
    // that arrived without leaving the non-member list, or left it without
    // arriving, changes exactly one of these two numbers.
    expect(PER_USER_STATE_FAMILY).toHaveLength(8)
    expect(PER_USER_STATE_NON_MEMBERS).toHaveLength(1)
    expect(PER_USER_STATE_FAMILY.map((m) => m.name).sort()).toEqual([
      'issueMessageReadState',
      'issueUserState',
      'personalPreference',
      'pin',
      'sessionReadState',
      'sessionSnooze',
      'sidebarAndTabLayout',
      'tabOrder',
    ])
    // The moved entries are gone from the OTHER list, not merely added here.
    expect(PER_USER_STATE_NON_MEMBERS.map((n) => n.name)).not.toContain('personalPreferenceKeys')
    expect(PER_USER_STATE_NON_MEMBERS.map((n) => n.name)).not.toContain('sidebarAndTabLayout')
  })

  it('every member names a real table, and no two members claim the same one', () => {
    const tables = PER_USER_STATE_FAMILY.map((m) => m.table)
    expect(tables.every((t) => t.length > 0)).toBe(true)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it('every declared non-member carries the REASON it has no row', () => {
    // An unexplained absence from a totality list is indistinguishable from a
    // member somebody forgot, which is the failure this list exists to prevent.
    for (const n of PER_USER_STATE_NON_MEMBERS) {
      expect(n.reason.length, n.name).toBeGreaterThan(40)
    }
  })
})

describe('every member composes the ONE (userId, entityId) fragment', () => {
  it.each(PER_USER_STATE_FAMILY)('$name keys on userId + entityId', ({ schema }) => {
    expect(Object.keys(schema.shape).slice(0, 2)).toEqual(['userId', 'entityId'])
  })

  it('the userId field is the SHARED instance, not a same-shaped copy', () => {
    // `toBe`, not a parse comparison: a fresh z.string().brand<'UserId'>() would
    // pass every value-level check while forking the definition — the drift a
    // golden wire test is structurally blind to.
    const shared = PerUserKey.shape.userId
    for (const { name, schema } of PER_USER_STATE_FAMILY) {
      expect(schema.shape.userId, name).toBe(shared)
    }
  })

  it('the probe: a same-shaped FORK of the fragment fails the assertion above', () => {
    // Without this, "every member is the shared instance" could be passing because
    // `toBe` was comparing something to itself. A hand-rolled member that parses
    // identically must be REJECTED, or the check above proves nothing.
    const forked = z.object({ userId: z.string().brand<'UserId'>(), entityId: SessionIdField })
    expect(forked.safeParse({ userId: 'u1', entityId: 's1' }).success).toBe(true)
    expect(forked.shape.userId).not.toBe(PerUserKey.shape.userId)
  })

  it('the branded members keep the entity brand; the path-keyed ones decline it explicitly', () => {
    // Snooze and read state are about a SESSION, so their entity half is the
    // branded field instance; the issue members are about an ISSUE.
    expect(SessionSnoozeState.shape.entityId).toBe(SessionIdField)
    expect(SessionReadState.shape.entityId).toBe(SessionIdField)
    expect(IssueUserState.shape.entityId).toBe(IssueIdField)
    // Pins, tab order and issue messages are keyed by a path or an id with no
    // brand in the POD-301 family, so they cannot be branded — but they must
    // still refuse a non-string, or "unbranded" would have quietly become
    // "unvalidated".
    expect(PinState.shape.entityId.safeParse('/repo/a').success).toBe(true)
    expect(PinState.shape.entityId.safeParse(42).success).toBe(false)
    expect(TabOrderState.shape.entityId.safeParse(42).success).toBe(false)
    expect(IssueMessageReadState.shape.entityId.safeParse(42).success).toBe(false)
    // A personal preference's entity half is a dotted settings PATH, so it
    // declines the brand for the same reason and must still refuse a non-string.
    expect(PersonalPreferenceState.shape.entityId.safeParse('sidebar.repoSort').success).toBe(true)
    expect(PersonalPreferenceState.shape.entityId.safeParse(42).success).toBe(false)
    // Layout keys are the same unbranded path shape.
    expect(LayoutState.shape.entityId.safeParse('dockTab').success).toBe(true)
    expect(LayoutState.shape.entityId.safeParse(42).success).toBe(false)
  })

  it('no member carries a `visibility` field — the class is a matrix annotation, never a per-row value', () => {
    // ADR 9 D3: per-user state is non-grantable BY CONSTRUCTION. A row-level
    // visibility field would be a value a writer could set wrong.
    for (const { name, schema } of PER_USER_STATE_FAMILY) {
      expect(Object.keys(schema.shape), name).not.toContain('visibility')
      expect(Object.keys(schema.shape), name).not.toContain('grants')
      expect(Object.keys(schema.shape), name).not.toContain('owner')
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

  it('read state is nullable but never absent — "never opened" is a value, not a missing field', () => {
    const key = { userId: 'u1', entityId: 's1' }
    expect(SessionReadState.safeParse({ ...key, readAt: null }).success).toBe(true)
    expect(SessionReadState.safeParse({ ...key }).success).toBe(false)
  })

  it('a pin declares which kind of thing it points at, from a closed set', () => {
    const base = { userId: 'u1', entityId: '/repo/a' }
    expect(PinState.safeParse({ ...base, kind: 'repo' }).success).toBe(true)
    expect(PinState.safeParse({ ...base, kind: 'session' }).success).toBe(false)
  })

  it('the three issue markers are one row, and all three are independently nullable', () => {
    const key = { userId: 'u1', entityId: 'i1' }
    expect(
      IssueUserState.safeParse({ ...key, readAt: null, tuckedAt: null, pinnedAt: null }).success,
    ).toBe(true)
    // A row missing one marker is not a valid row: three spellings of "not done"
    // (null, absent, and a default) is how a per-user table acquires a second
    // meaning nobody documented.
    expect(IssueUserState.safeParse({ ...key, readAt: null, tuckedAt: null }).success).toBe(false)
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

describe('the projection overlays', () => {
  it('an absent issue row and an all-null issue row project identically', () => {
    // The two spellings of "this person has done nothing to this issue" must be
    // one wire value, or a client would render a tucked-away issue differently
    // depending on whether a row was ever written and then cleared.
    expect(issueOverlayOf(undefined)).toEqual(NO_ISSUE_USER_STATE)
    expect(issueOverlayOf({ readAt: null, tuckedAt: null, pinnedAt: null })).toEqual(
      NO_ISSUE_USER_STATE,
    )
  })

  it('`pinned` is derived from pinnedAt in exactly one place', () => {
    expect(issueOverlayOf({ readAt: null, tuckedAt: null, pinnedAt: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ readAt: null, tuckedAt: null, pinned: true })
  })

  it('the empty session overlay is never-opened and never-snoozed, and they differ', () => {
    // `readAt: null` = never opened. `snoozedUntil: undefined` = no snooze row,
    // which is NOT the same as `snoozedUntil: null` (until-next-message). A single
    // shared "empty" value that collapsed them would un-snooze every session with
    // an open-ended snooze on the first projection.
    expect(NO_SESSION_USER_STATE.readAt).toBeNull()
    expect(NO_SESSION_USER_STATE.snoozedUntil).toBeUndefined()
  })
})

describe('the fragment factory is reused, not re-implemented', () => {
  it('perUserKey(X) puts the user half in the same position for any entity brand', () => {
    expect(Object.keys(perUserKey(SessionIdField).shape)).toEqual(['userId', 'entityId'])
    expect(Object.keys(perUserKey(IssueIdField).shape)).toEqual(['userId', 'entityId'])
  })
})

describe('layout key routing (POD-1350 / POD-403 shared vocabulary)', () => {
  it('admits every exact key and every dynamic section key under an allowed prefix', () => {
    for (const key of LAYOUT_EXACT_KEYS) {
      expect(isLayoutKey(key), key).toBe(true)
    }
    expect(isLayoutKey('sidebar.section.closed')).toBe(true)
    expect(isLayoutKey('dock.section.files')).toBe(true)
  })

  it('refuses free-form keys, bare prefixes, and device-local geometry', () => {
    expect(isLayoutKey('not.a.layout.key')).toBe(false)
    expect(isLayoutKey('sidebar.section')).toBe(false)
    expect(isLayoutKey('podium.view')).toBe(false)
    expect(isLayoutKey('sidebar.width')).toBe(false)
  })

  it('maps legacy ui-state keys onto layout keys, and leaves device-local keys unmapped', () => {
    expect(layoutKeyFromLegacy('podium.dockTab')).toBe('dockTab')
    expect(layoutKeyFromLegacy('podium.superOpen.v2')).toBe('superOpen')
    expect(layoutKeyFromLegacy('podium:sidebar:collapsed')).toBe('sidebar.collapsed')
    expect(layoutKeyFromLegacy('podium:sidebar:projects')).toBe('sidebar.section.projects')
    expect(layoutKeyFromLegacy('podium.dock.section.mail')).toBe('dock.section.mail')
    // Device-local: never become layout rows.
    for (const key of DEVICE_LOCAL_UI_KEYS) {
      expect(layoutKeyFromLegacy(key), key).toBeNull()
    }
  })

  it('a layout row parses like a personal preference row', () => {
    expect(
      LayoutState.safeParse({ userId: 'user:sole', entityId: 'dockTab', value: 'files' }).success,
    ).toBe(true)
    expect(LayoutState.safeParse({ userId: 'user:sole', entityId: 'dockTab' }).success).toBe(false)
  })
})
