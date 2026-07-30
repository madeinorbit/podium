import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { asAgentIdentityId, asUserId } from '../ids/brands'
import {
  AgentDelegation,
  DELEGATION_DECLARED_OPERAND_KEYS,
  DelegationScope,
} from './delegation'

const delegation = (over: Record<string, unknown> = {}) => ({
  agentIdentity: asAgentIdentityId('agent-1'),
  onBehalfOf: asUserId('user:sole'),
  scope: { kind: 'subtree', rootId: 'issue-7' },
  parentAgentIdentity: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  ...over,
})

describe('the delegation shape is (agentIdentity, onBehalfOf, scope) — ADR 9 D5 A1', () => {
  it('parses the three parts plus the chaining half', () => {
    expect(AgentDelegation.safeParse(delegation()).success).toBe(true)
  })

  it('refuses a delegation with no human — there is exactly ONE at the root', () => {
    const { onBehalfOf: _dropped, ...noHuman } = delegation()
    expect(AgentDelegation.safeParse(noHuman).success).toBe(false)
  })

  it('makes `parentAgentIdentity` nullable but never ABSENT', () => {
    // `null` is a representable "this is the root of the chain". An absent key
    // would mean nobody threaded the value — and a reader that treats a missing
    // parent as "root" lets a sub-agent present itself as one and escape its
    // parent's bound (ADR 9 D5, "Chaining").
    const { parentAgentIdentity: _dropped, ...noParent } = delegation()
    expect(AgentDelegation.safeParse(noParent).success).toBe(false)
    expect(AgentDelegation.safeParse(delegation({ parentAgentIdentity: null })).success).toBe(true)
    expect(
      AgentDelegation.safeParse(delegation({ parentAgentIdentity: asAgentIdentityId('parent') }))
        .success,
    ).toBe(true)
  })
})

describe('the scope vocabulary IS the enforcement function’s closed set', () => {
  it('carries exactly the five IssueScope members', () => {
    // A second scope vocabulary would be two closed sets kept in step by hand,
    // and the one that is NOT the enforcement function's would be the one that
    // silently drifts. The compile-time pins in delegation.ts assert
    // assignability in both directions; this is the runtime half.
    const kinds = DelegationScope.options.map((o) => o.shape.kind.value).sort()
    expect(kinds).toEqual(['all', 'none', 'owned', 'self', 'subtree'])
  })

  it('admits `all` — a superagent is a broad delegation, not a fifth kind (D8 S1)', () => {
    expect(DelegationScope.safeParse({ kind: 'all' }).success).toBe(true)
  })

  it('refuses a scope kind nobody declared', () => {
    expect(DelegationScope.safeParse({ kind: 'everything' }).success).toBe(false)
    expect(DelegationScope.safeParse({ kind: 'subtree' }).success).toBe(false) // rootId required
  })
})

describe('there is NO serializable effective capability (ADR 9 D5 A1)', () => {
  /**
   * THE PIN. `scope` is the declared LEFT OPERAND of the intersection, not its
   * result — see delegation.ts's header for why that distinction decides whether
   * this file is compliant or is the exact leak the ADR rejects.
   *
   * The detector is never widened to accommodate this file. Its verdict is
   * pinned to the declared operands, so anything new that the detector matches
   * changes the list and fails here.
   */
  it('the detector’s verdict is exactly the declared operand keys', () => {
    expect(findCapabilitySnapshotKeys(AgentDelegation)).toEqual([
      ...DELEGATION_DECLARED_OPERAND_KEYS,
    ])
  })

  it('carries no resolved-rights key under any spelling', () => {
    const keys = Object.keys(AgentDelegation.shape).map((k) => k.toLowerCase())
    for (const forbidden of ['effectiverights', 'capabilities', 'capability', 'permissions', 'acl', 'allowed', 'rights']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('FIRES on a snapshot added beside the operand — the instrument can say NO', () => {
    // Without this, the pin above could be passing because the detector never
    // fires on this shape at all. This is the mutant: a plausible, additive,
    // byte-safe-looking field that IS the privilege leak.
    const snapshotted = AgentDelegation.extend({
      effectiveRights: z.array(z.string()),
    })
    expect(findCapabilitySnapshotKeys(snapshotted).sort()).toEqual(['effectiveRights', 'scope'])
  })

  it('FIRES on one nested inside the scope, not just at the top level', () => {
    // The renamed / nested spelling, which is how this mistake actually arrives:
    // "just cache the resolved set next to the scope it came from".
    const nested = AgentDelegation.extend({
      scope: z.object({ kind: z.literal('all'), resolvedPermissions: z.array(z.string()) }),
    })
    expect(findCapabilitySnapshotKeys(nested)).toContain('scope.resolvedPermissions')
  })

  it('carries no expiry — revocation is disabling the human, resolved live', () => {
    // An expiry would be a second revocation path with its own reaper to write
    // and to forget. ADR 9 D5 A1's whole argument is that live resolution needs
    // no cleanup step.
    expect(AgentDelegation.shape).not.toHaveProperty('expiresAt')
    expect(AgentDelegation.shape).not.toHaveProperty('revokedAt')
  })
})
