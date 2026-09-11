/**
 * The ambient that replaced `FIRST_ADMIN_USER_ID` (A2).
 *
 * Three properties are worth pinning, and they are the three a reviewer would
 * ask about a module holding process-wide state: that an unprimed read REFUSES
 * rather than guessing, that priming is what makes it answer, and that the slot
 * is shared rather than per-copy — because a second copy of this package with
 * its own `let` is the failure POD-746 already measured once, in the migrator.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { asUserId } from '../ids/brands'
import {
  clearFirstAdminMember,
  firstAdminMemberId,
  firstAdminMemberIdOrUndefined,
  primeFirstAdminMember,
} from './first-admin'

const MEMBER = 'mem_0ujtsYcgvSTl8PAuAdqWYSMnLOv'

afterEach(() => {
  clearFirstAdminMember()
})

describe('the first admin member, unprimed', () => {
  it('throws rather than answering', () => {
    clearFirstAdminMember()
    expect(() => firstAdminMemberId()).toThrow(/not resolved/)
  })

  it('names both ways in, because the two callers who hit this are a test and a tool', () => {
    clearFirstAdminMember()
    expect(() => firstAdminMemberId()).toThrow(/SessionStore\.open|applyBaselineSchema/)
  })

  it('does NOT fall back to the retired literal', () => {
    // The whole point. A fallback would put `'user:sole'` — an id naming no row
    // after the migration — into an owner column, where it reads as a valid
    // principal that no query returns and nobody can log in as.
    clearFirstAdminMember()
    let thrown: unknown
    try {
      firstAdminMemberId()
    } catch (err) {
      thrown = err
    }
    expect(String(thrown)).not.toContain('user:sole')
    expect(firstAdminMemberIdOrUndefined()).toBeUndefined()
  })
})

describe('the first admin member, primed', () => {
  it('answers with the member it was given', () => {
    primeFirstAdminMember(MEMBER)
    expect(firstAdminMemberId()).toBe(asUserId(MEMBER))
  })

  it('reports the member it replaced, so a second open is visible to its caller', () => {
    // Two instances open in one process is a real state in the multi-instance
    // lane. The newest open wins — as it did when both spelled one literal —
    // but the caller can see that it happened.
    primeFirstAdminMember(MEMBER)
    const previous = primeFirstAdminMember('mem_0ujzPyRiIAffKhBux4PvQdDqMHY')
    expect(previous).toBe(asUserId(MEMBER))
    expect(firstAdminMemberId()).toBe(asUserId('mem_0ujzPyRiIAffKhBux4PvQdDqMHY'))
  })

  it('is re-primeable with the same id without complaint', () => {
    primeFirstAdminMember(MEMBER)
    expect(primeFirstAdminMember(MEMBER)).toBe(asUserId(MEMBER))
    expect(firstAdminMemberId()).toBe(asUserId(MEMBER))
  })
})

describe('the slot is shared, not per-copy', () => {
  it('is reachable through the well-known symbol a second copy of this module would use', () => {
    // The property, asserted from the outside: a duplicate copy of
    // `@podium/model` would prime and read THIS, rather than a `let` of its own
    // that the other copy never sees.
    primeFirstAdminMember(MEMBER)
    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for('podium.identity.firstAdminMember')
    ]
    expect(slot).toBe(asUserId(MEMBER))
  })
})
