import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { asUserId } from '../ids/brands'
import { SOLE_USER_ID } from '../user-state/session-state'
import {
  CREDENTIAL_SOURCES,
  FIRST_ADMIN_ROLE,
  FIRST_ADMIN_USER_ID,
  isAdminGrade,
  USER_ROLES,
  UserAccount,
  UserCredential,
  UserRole,
  UserWire,
} from './user'

describe('roles are a CLOSED enum with a totality obligation (ADR 9 D1.4)', () => {
  it('is exactly admin and member — ADR 9 D1.4’s minimum, and the whole set today', () => {
    expect([...USER_ROLES]).toEqual(['admin', 'member'])
  })

  it('the zod enum and the vocabulary are ONE list, not two that agree', () => {
    // Structural, not conventional: the enum is derived from USER_ROLES, so this
    // cannot pass while the two have drifted.
    expect(UserRole.options).toBe(USER_ROLES)
  })

  it('refuses a role outside the set — the enum is a gate, not documentation', () => {
    expect(UserRole.safeParse('admin').success).toBe(true)
    expect(UserRole.safeParse('member').success).toBe(true)
    expect(UserRole.safeParse('owner').success).toBe(false)
    expect(UserRole.safeParse('superadmin').success).toBe(false)
    // Unknown input fails CLOSED rather than being coerced to the weaker role.
    expect(UserRole.safeParse('').success).toBe(false)
  })

  it('decides admin-grade for EVERY member — no role has an undecided answer', () => {
    // The totality obligation as a runtime assertion: iterate the vocabulary
    // rather than naming two roles, so a third added to USER_ROLES without a
    // switch arm reaches `assertUnreachable` here and throws instead of
    // silently inheriting `member`'s answer.
    const decided = USER_ROLES.map((role) => [role, isAdminGrade(role)] as const)
    expect(decided).toEqual([
      ['admin', true],
      ['member', false],
    ])
  })

  it('says YES and NO — an admin-grade check that only ever refused would be vacuous', () => {
    expect(isAdminGrade('admin')).toBe(true)
    expect(isAdminGrade('member')).toBe(false)
  })

  it('throws on a role outside the vocabulary rather than answering false', () => {
    // The instrument's own failure mode, pinned. `role === 'admin'` would answer
    // `false` here — safe, but silently, which is how a role acquires a meaning
    // nobody chose. The exhaustive switch refuses to guess.
    expect(() => isAdminGrade('root' as UserRole)).toThrow()
  })
})

describe('credential material is not part of any wire projection (ADR 9 D1.2, ADR 1 D6)', () => {
  it('is a SEPARATE schema — the account has no credential key to leak', () => {
    // The structural half: there is no key to forget to strip, because
    // UserAccount does not have one. An omit-list would be a hand-maintained
    // copy of "what must not escape", and a field added to R1 would land on the
    // wire by default.
    for (const key of Object.keys(UserCredential.shape)) {
      if (key === 'userId') continue // the join key, legitimately on both
      expect(Object.keys(UserAccount.shape)).not.toContain(key)
    }
  })

  it('the wire projection carries no secret-shaped key at any depth', () => {
    // The detector half, and deliberately a different instrument from the one
    // above: this would catch a credential re-added under a name the structural
    // check does not know to look for.
    const SECRET_SHAPED = /password|credential|hash|secret|token|salt/i
    for (const key of Object.keys(UserWire.shape)) {
      expect(key).not.toMatch(SECRET_SHAPED)
    }
  })

  it('DETECTS a credential smuggled onto the wire — proving the check can say NO', () => {
    // Without this, both assertions above could be passing because they are
    // looking at a shape too small to violate them.
    const leaky = UserWire.extend({ passwordHash: z.string() })
    const SECRET_SHAPED = /password|credential|hash|secret|token|salt/i
    const hits = Object.keys(leaky.shape).filter((k) => SECRET_SHAPED.test(k))
    expect(hits).toEqual(['passwordHash'])
  })

  it('the wire projection is a PICK from R1, so a new R1 field is absent by default', () => {
    // The direction that makes the default safe. Every wire key must exist on
    // the aggregate; the converse deliberately does not hold.
    for (const key of Object.keys(UserWire.shape)) {
      expect(Object.keys(UserAccount.shape)).toContain(key)
    }
    expect(Object.keys(UserWire.shape).sort()).toEqual([
      'disabledAt',
      'displayName',
      'role',
      'userId',
    ])
  })

  it('names ONE credential source — `instance-password` is retired (POD-1554)', () => {
    // Every account now authenticates the same way: a per-account scrypt hash in
    // its own row. The boot migration moved the last instance-password holder
    // (the first admin) into one, so the model has no word for the indirection
    // any more — and a row that still claims it must FAIL to parse rather than
    // be admitted as some other kind of credential.
    expect([...CREDENTIAL_SOURCES]).toEqual(['per-user-scrypt'])
    const retired = UserCredential.safeParse({
      userId: asUserId('u'),
      source: 'instance-password',
      passwordHash: null,
      updatedAt: '2026-07-30T00:00:00.000Z',
    })
    expect(retired.success).toBe(false)
  })

  it('makes `passwordHash` nullable but never ABSENT', () => {
    // `null` is a representable "the material lives in auth.json"; an absent key
    // would be indistinguishable from "nobody wrote one".
    const missing = UserCredential.safeParse({
      userId: asUserId('u'),
      source: 'per-user-scrypt',
      updatedAt: '2026-07-30T00:00:00.000Z',
    })
    expect(missing.success).toBe(false)
  })
})

describe('the account role is durable identity, not a capability snapshot (ADR 9 D5 A1)', () => {
  /**
   * POD-643's detector matches `role` by name, and it is RIGHT to. The carve-out
   * is a PINNED EXPECTATION rather than a widened detector: the day someone adds
   * `effectiveRights`, `capabilities`, `grants` or `permissions` to the account,
   * this list changes and this test fails.
   */
  it('the detector’s verdict on UserAccount is exactly ["role"]', () => {
    expect(findCapabilitySnapshotKeys(UserAccount)).toEqual(['role'])
  })

  it('and it FIRES on a genuine snapshot added beside it', () => {
    // The counterfactual, without which the pin above could be passing because
    // the detector never fires on this shape at all.
    const snapshotted = UserAccount.extend({
      effectiveRights: z.array(z.string()),
    })
    expect(findCapabilitySnapshotKeys(snapshotted).sort()).toEqual(['effectiveRights', 'role'])
  })

  it('the credential carries NO authority key at all', () => {
    expect(findCapabilitySnapshotKeys(UserCredential)).toEqual([])
  })
})

describe('the first admin reconciles the two pre-accounts constants (POD-1172)', () => {
  it('is the value that is already WRITTEN DOWN in the database', () => {
    // The POD-380 migration backfilled every pin, snooze and tab-order row with
    // the literal 'user:sole'. A migration is frozen history, so the surviving
    // spelling is the one those rows carry — choosing the other constant would
    // have meant a second data migration to re-key rows that are correct.
    expect(FIRST_ADMIN_USER_ID).toBe('user:sole')
    expect(FIRST_ADMIN_USER_ID).toBe(asUserId(SOLE_USER_ID))
  })

  it('is an ADMIN — on an upgraded instance it is the only account there is', () => {
    expect(FIRST_ADMIN_ROLE).toBe('admin')
    expect(isAdminGrade(FIRST_ADMIN_ROLE)).toBe(true)
  })

  it('is a real account shape, not a sentinel string', () => {
    const account = UserAccount.safeParse({
      userId: FIRST_ADMIN_USER_ID,
      displayName: 'Operator',
      role: FIRST_ADMIN_ROLE,
      createdAt: '2026-07-30T00:00:00.000Z',
      disabledAt: null,
      owner: FIRST_ADMIN_USER_ID,
      visibility: 'personal',
      createdBy: {
        actor: { kind: 'system', job: 'user-accounts-migration' },
        // ADR 9 D8 S5: a system job has NO human and must never be given one.
        onBehalfOf: null,
      },
    })
    expect(account.success).toBe(true)
  })
})
