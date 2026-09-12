/**
 * THE MEMBER DIRECTORY — naming people without disclosing who runs the place (A2).
 *
 * Every surface that has to name a person — an assignment picker, a participation
 * chip, the "assigned to" filter — needed a shape, and the only one that existed
 * was {@link UserWire}, which carries `role`. Handing a picker the role means
 * every surface that renders a name also learns who the admins are: a disclosure
 * made by accident, because the only available projection happened to include it.
 *
 * These tests pin the two halves of the answer — what the directory carries, and
 * what it must not — as a `pick` list rather than as an omission, so a field added
 * to the account aggregate is ABSENT here until someone adds it deliberately.
 */

import { describe, expect, it } from 'vitest'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { isActiveMember, MemberDirectoryEntry, UserAccount, UserWire } from './user'

const active = { userId: 'mem_a', displayName: 'A', disabledAt: null }

describe('member directory entry', () => {
  it('carries identity and active state, and nothing else', () => {
    expect(Object.keys(MemberDirectoryEntry.shape).sort()).toEqual([
      'disabledAt',
      'displayName',
      'userId',
    ])
  })

  it('does NOT carry the account role', () => {
    // The disclosure this shape exists to avoid. Nothing a directory does needs
    // the role: reassignment is member-to-member (D2), there is no viewer role
    // (D6), and admin-grade powers are secrets, substrate and fleet management —
    // none of which a name picker performs.
    expect(Object.keys(MemberDirectoryEntry.shape)).not.toContain('role')
    expect(Object.keys(UserWire.shape)).toContain('role')
  })

  it('is a PICK of the account, so a new account field is absent by default', () => {
    // Direction matters: an omit-list is a hand-maintained copy of "what must not
    // escape", so a field added to R1 lands on the wire BY DEFAULT and the mistake
    // is invisible in the diff. Every key here is the account's own instance.
    for (const key of Object.keys(MemberDirectoryEntry.shape) as (keyof typeof active)[]) {
      expect(MemberDirectoryEntry.shape[key]).toBe(UserAccount.shape[key])
    }
  })

  it('carries no capability snapshot', () => {
    // ADR 9 D5 A1, checked by the repo's own detector rather than by eye.
    // `UserAccount` has a PINNED carve-out for `role`; this projection drops the
    // role, so it must come back completely clean — and a future `effectiveRights`
    // or `grants` added here fails without anyone remembering to look.
    expect(findCapabilitySnapshotKeys(MemberDirectoryEntry)).toEqual([])
    // The counterfactual, so the detector is known to be looking: the account it
    // is picked from still trips on its pinned carve-out.
    expect(findCapabilitySnapshotKeys(UserAccount)).toEqual(['role'])
  })
})

describe('active membership', () => {
  it('reads active as "not disabled", once', () => {
    expect(isActiveMember(active)).toBe(true)
    expect(isActiveMember({ disabledAt: '2026-09-01T00:00:00Z' })).toBe(false)
  })

  it('can still REPRESENT a disabled member, because A2 adds no offboarding', () => {
    // The charter is explicit (D12): a disabled account keeps its rows and its
    // ownership. So the directory must be able to carry one — a task a suspended
    // member still owns has to render a name rather than a bare id. A projection
    // that dropped them would turn "no offboarding" into "offboarding, badly".
    const suspended = MemberDirectoryEntry.parse({
      userId: 'mem_b',
      displayName: 'B',
      disabledAt: '2026-09-01T00:00:00Z',
    })
    expect(suspended.disabledAt).not.toBeNull()
    expect(isActiveMember(suspended)).toBe(false)
  })

  it('refuses an ABSENT disabled marker rather than reading it as active', () => {
    // `.nullable()` and not `.optional()`, for the reason `Attribution.onBehalfOf`
    // is: `null` is a representable "this account is active", while an absent key
    // would mean "nobody threaded the value" — and a reader that treats a missing
    // marker as enabled fails OPEN on a disabled account.
    expect(MemberDirectoryEntry.safeParse({ userId: 'mem_c', displayName: 'C' }).success).toBe(
      false,
    )
  })
})
