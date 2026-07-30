import { describe, expect, it } from 'vitest'
import {
  type AuthDecision,
  authorize,
  type Capability,
  type IssueScope,
  OPERATOR,
} from './issue-authz'

const cap = (scope: IssueScope, role: Capability['role'] = 'worker'): Capability => ({
  role,
  scope,
})

describe('authorize — role gate', () => {
  it('denies an action the role does not carry, whatever the scope', () => {
    expect(authorize(cap({ kind: 'all' }, 'viewer'), 'write')).toBe('forbidden')
    expect(authorize(cap({ kind: 'all' }, 'worker'), 'manage')).toBe('forbidden')
    expect(authorize(cap({ kind: 'all' }, 'admin'), 'manage')).toBe('allow')
  })

  it('leaves the operator unconstrained', () => {
    expect(authorize(OPERATOR, 'manage', { id: 'i1' })).toBe('allow')
  })
})

describe('authorize — scope gate', () => {
  it('reads are scope-free', () => {
    expect(authorize(cap({ kind: 'none' }), 'read', { id: 'i1' })).toBe('allow')
    expect(authorize(cap({ kind: 'subtree', rootId: 'root' }), 'read', { id: 'i1' })).toBe('allow')
  })

  it('allows an additive write (no existing target) on role alone', () => {
    expect(authorize(cap({ kind: 'none' }), 'write')).toBe('allow')
    expect(authorize(cap({ kind: 'subtree', rootId: 'root' }), 'write')).toBe('allow')
  })

  it('gates a write to an EXISTING issue by scope, overridably', () => {
    const outside = { id: 'other', ancestorIds: ['unrelated'] }
    const inside = { id: 'child', ancestorIds: ['root'] }
    const scoped = cap({ kind: 'subtree', rootId: 'root' })
    expect(authorize(scoped, 'write', inside)).toBe('allow')
    expect(authorize(scoped, 'write', { id: 'root' })).toBe('allow')
    expect(authorize(scoped, 'write', outside)).toBe('confirm-required')
    expect(authorize(scoped, 'write', outside, { override: true })).toBe('allow')
    expect(authorize(cap({ kind: 'none' }), 'write', inside)).toBe('confirm-required')
  })
})

describe('the scope set is CLOSED, with compiler-enforced totality (POD-299)', () => {
  /**
   * This is the guard the multi-user extension rests on
   * (docs/multi-user-readiness.md §3.2): POD-1075 and Phase 3 add owner-scoped
   * and grant-scoped members to `IssueScope`, and every site that matches on
   * `kind` must then FAIL TO COMPILE rather than fall into a default that would
   * fail open.
   *
   * `Record<IssueScope['kind'], …>` is missing-key-checked by the compiler, so
   * this map is a second enforced match site: add a member to the union without
   * listing it here and `bun run typecheck` fails. `authorize`'s own switch is
   * the first, via `default: assertUnreachable(scope)` — delete that default and
   * the compiler stops guarding it, which is why this test names it.
   */
  const EXPECTED_FOR_EXISTING_ISSUE: Record<IssueScope['kind'], AuthDecision> = {
    all: 'allow',
    none: 'confirm-required',
    subtree: 'confirm-required',
  }

  const SCOPES: Record<IssueScope['kind'], IssueScope> = {
    all: { kind: 'all' },
    none: { kind: 'none' },
    subtree: { kind: 'subtree', rootId: 'elsewhere' },
  }

  it('every declared scope kind has an explicit rule for an out-of-scope write', () => {
    for (const [kind, expected] of Object.entries(EXPECTED_FOR_EXISTING_ISSUE)) {
      const scope = SCOPES[kind as IssueScope['kind']]
      expect(authorize(cap(scope), 'write', { id: 'i1' })).toBe(expected)
    }
  })

  it('preserves Capability.actorSessionId — the ACTOR half of §3.1.3 A3 attribution', () => {
    const withActor: Capability = {
      role: 'worker',
      scope: { kind: 'subtree', rootId: 'root' },
      actorSessionId: 's1',
    }
    expect(withActor.actorSessionId).toBe('s1')
    // The seam is carried, not consulted: authz decisions do not read it.
    expect(authorize(withActor, 'write', { id: 'root' })).toBe('allow')
  })
})
