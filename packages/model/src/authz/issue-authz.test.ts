import { describe, expect, it } from 'vitest'
import { asIssueId, asSessionId, asUserId } from '../ids/brands'
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
  /**
   * NARROWED AT POD-315 from "reads are scope-free" to "reads are scope-free for
   * the scopes that name no person" (ADR 3 Amendment 1 D19.2). The `owned` / `self`
   * halves of the same rule are asserted in their own describes below, where the
   * denial counterfactual lives.
   *
   * `subtree` is the load-bearing one and it is here rather than beside the others
   * on purpose: it is the scope agents actually carry, and gating reads by it would
   * deny an agent every sibling issue — contradicting D20.2 (an agent may address
   * any issue its HUMAN can see, outside its own subtree included) and failing the
   * single-user parity criterion outright.
   */
  it('reads are scope-free for the scopes that name no person', () => {
    expect(authorize(cap({ kind: 'none' }), 'read', { id: 'i1' })).toBe('allow')
    expect(authorize(cap({ kind: 'subtree', rootId: asIssueId('root') }), 'read', { id: 'i1' })).toBe('allow')
    expect(authorize(OPERATOR, 'read', { id: 'i1' })).toBe('allow')
    // The counterfactual that stops this reading as "reads are still ungated":
    // the SAME read, under a scope that does name a person, is refused.
    expect(
      authorize(cap({ kind: 'owned', userId: asUserId('alice') }), 'read', {
        kind: 'owned',
        id: 's1',
        owner: 'bob',
      }),
    ).toBe('forbidden')
  })

  it('allows an additive write (no existing target) on role alone', () => {
    expect(authorize(cap({ kind: 'none' }), 'write')).toBe('allow')
    expect(authorize(cap({ kind: 'subtree', rootId: asIssueId('root') }), 'write')).toBe('allow')
  })

  it('gates a write to an EXISTING issue by scope, overridably', () => {
    const outside = { id: 'other', ancestorIds: ['unrelated'] }
    const inside = { id: 'child', ancestorIds: ['root'] }
    const scoped = cap({ kind: 'subtree', rootId: asIssueId('root') })
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
    // POD-380: an owner-or-grant capability says nothing about issue TREES, and a
    // self capability reaches only its own per-user row. Both are 'forbidden' for
    // an issue target rather than 'confirm-required' — deliberately NOT overridable,
    // because `--outside-scope` confirms crossing an issue boundary (ADR 3 D2) and
    // must not double as a general escalation into another class.
    owned: 'forbidden',
    self: 'forbidden',
  }

  const SCOPES: Record<IssueScope['kind'], IssueScope> = {
    all: { kind: 'all' },
    none: { kind: 'none' },
    subtree: { kind: 'subtree', rootId: asIssueId('elsewhere') },
    owned: { kind: 'owned', userId: asUserId('u1') },
    self: { kind: 'self', userId: asUserId('u1') },
  }

  /**
   * The READ half of the same totality obligation (POD-315). Before D19.2 no such
   * map could exist — every entry would have been `allow` by the short-circuit —
   * so a new scope member could be added without anyone deciding what it may SEE.
   * `Record<IssueScope['kind'], …>` is missing-key-checked, so it cannot now.
   */
  const EXPECTED_READ_OF_ANOTHERS_ENTITY: Record<IssueScope['kind'], AuthDecision> = {
    all: 'allow',
    none: 'allow',
    subtree: 'allow',
    // The two scopes that name a person: gated by ownership, exactly as writes are.
    owned: 'forbidden',
    self: 'forbidden',
  }

  it('every declared scope kind has an explicit rule for reading another person’s entity', () => {
    const someoneElses = { kind: 'owned', id: 's1', owner: 'bob' } as const
    for (const [kind, expected] of Object.entries(EXPECTED_READ_OF_ANOTHERS_ENTITY)) {
      const scope = SCOPES[kind as IssueScope['kind']]
      expect(authorize(cap(scope), 'read', someoneElses), kind).toBe(expected)
    }
  })

  it('every declared scope kind has an explicit rule for an out-of-scope write', () => {
    for (const [kind, expected] of Object.entries(EXPECTED_FOR_EXISTING_ISSUE)) {
      const scope = SCOPES[kind as IssueScope['kind']]
      expect(authorize(cap(scope), 'write', { id: 'i1' }), kind).toBe(expected)
    }
  })

  it('the new scopes are not override-liftable on an issue target', () => {
    // The claim above says "deliberately NOT overridable". This is the assertion
    // for it: without this, 'forbidden' could be a confirm-required in disguise.
    for (const kind of ['owned', 'self'] as const) {
      expect(authorize(cap(SCOPES[kind]), 'write', { id: 'i1' }, { override: true }), kind).toBe(
        'forbidden',
      )
    }
  })

  it('preserves Capability.actorSessionId — the ACTOR half of §3.1.3 A3 attribution', () => {
    const withActor: Capability = {
      role: 'worker',
      scope: { kind: 'subtree', rootId: asIssueId('root') },
      actorSessionId: asSessionId('s1'),
    }
    expect(withActor.actorSessionId).toBe('s1')
    // The seam is carried, not consulted: authz decisions do not read it.
    expect(authorize(withActor, 'write', { id: 'root' })).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// POD-380 — owner-or-grant and self scopes (docs/multi-user-readiness.md §3.1.1, §3.3)
// ---------------------------------------------------------------------------

/** An owned entity target: a session, with its owner and its grant list. */
const session = (owner: string | null, grants?: string[]) =>
  ({ kind: 'owned', id: 's1', owner, ...(grants ? { grants } : {}) }) as const

describe('owner-or-grant scope (the personal class)', () => {
  const alice = cap({ kind: 'owned', userId: asUserId('alice') })

  it('allows the OWNER and allows a GRANTEE', () => {
    expect(authorize(alice, 'write', session('alice'))).toBe('allow')
    expect(authorize(alice, 'write', session('bob', ['alice']))).toBe('allow')
  })

  it('denies a principal who is neither owner nor grantee', () => {
    // The counterfactual for the two allows above: same capability, same target
    // shape, only the owner/grants differ.
    expect(authorize(alice, 'write', session('bob'))).toBe('forbidden')
    expect(authorize(alice, 'write', session('bob', ['carol']))).toBe('forbidden')
  })

  it('an UNOWNED entity is denied, not ambient — default-closed (§3.1.1, §3.1.4 M4)', () => {
    expect(authorize(alice, 'write', session(null))).toBe('forbidden')
    // And a grant list on an unowned row does not resurrect it: an owner is the
    // thing a grant hangs off, so "granted on an unowned entity" is incoherent.
    expect(authorize(alice, 'write', session(null, ['alice']))).toBe('forbidden')
  })

  it('--outside-scope does NOT lift an ownership denial', () => {
    // ADR 3 D2's override confirms crossing an ISSUE boundary. Letting it lift an
    // ownership refusal would make it a general escalation into another person's
    // private state.
    expect(authorize(alice, 'write', session('bob'), { override: true })).toBe('forbidden')
  })

  it('does not reach ANY per-user row, including its own (§3.3 non-grantable)', () => {
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: 'alice' })).toBe('forbidden')
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: 'bob' })).toBe('forbidden')
  })

  /**
   * FLIPPED AT POD-315, AND THE REASONING IT REPLACES IS WORTH KEEPING.
   *
   * POD-380 asserted the opposite here — *"reads stay allowed; visibility is the
   * feed's job, not this function's"* — on the grounds that scoping what a
   * principal may SEE is POD-1077's watermarked feed, and that a read gate here
   * would be the second permission check the extension contract's invariant 2
   * forbids. That was a real argument, and ADR 3 Amendment 1 adjudicated it
   * against itself in as many words: D19's rejected-alternatives table names
   * *"keep reads scope-free and filter results at the projection layer"* and
   * rejects it, because filtering after authorization means the authority
   * computed a forbidden row and then hoped every projection dropped it.
   *
   * Invariant 2 is honoured rather than broken by this: the gate is THIS
   * function, extended — no second evaluator was added beside it. The feed still
   * scopes the stream; that is a different question (which rows travel) asked of
   * a different consumer.
   */
  it('DENIES reading an entity it neither owns nor was granted (D19.2)', () => {
    expect(authorize(alice, 'read', session('bob'))).toBe('forbidden')
    expect(authorize(alice, 'read', session('bob', ['carol']))).toBe('forbidden')
    // Unowned is not ambient for reads either — default-closed (§3.1.1).
    expect(authorize(alice, 'read', session(null))).toBe('forbidden')
    // ...and --outside-scope does not lift a read denial any more than a write one.
    expect(authorize(alice, 'read', session('bob'), { override: true })).toBe('forbidden')
  })

  it('still ALLOWS reading what it owns or was granted — the denial is ownership talking', () => {
    // Without this pair the test above would also pass against a function that
    // refused every read, which is the failure mode a refusal-only assertion hides.
    expect(authorize(alice, 'read', session('alice'))).toBe('allow')
    expect(authorize(alice, 'read', session('bob', ['alice']))).toBe('allow')
    // An untargeted read (a list) is a role question, not an ownership one.
    expect(authorize(alice, 'read')).toBe('allow')
  })
})

describe('self scope (per-user state)', () => {
  const alice = cap({ kind: 'self', userId: asUserId('alice') })

  it('allows a principal to write its OWN row', () => {
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: 'alice' })).toBe('allow')
  })

  it('DENIES writing another principal’s row — the self-scoping property', () => {
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: 'bob' })).toBe('forbidden')
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: 'bob' }, { override: true })).toBe(
      'forbidden',
    )
  })

  it('cannot write a SHARED entity — a self capability is not a weak owner-or-grant', () => {
    // Without this, a per-user capability could rename the session its read state
    // is about, which would make `self` an owner-or-grant scope wearing the wrong
    // name.
    expect(authorize(alice, 'write', session('alice'))).toBe('forbidden')
  })

  it('an admin ROLE does not widen a self scope — role and scope are independent gates', () => {
    const adminSelf = cap({ kind: 'self', userId: asUserId('alice') }, 'admin')
    expect(authorize(adminSelf, 'manage', { kind: 'per-user-row', userId: 'bob' })).toBe('forbidden')
    // The counterfactual: the same admin capability CAN manage its own row, so the
    // denial above is the scope talking and not a blanket refusal.
    expect(authorize(adminSelf, 'manage', { kind: 'per-user-row', userId: 'alice' })).toBe('allow')
  })
})

describe('OPERATOR keeps its unconstrained reach across the new target kinds', () => {
  it('writes an owned entity it does not own, and any per-user row', () => {
    // Today's single shared password resolves to admin/all, and POD-380 must not
    // change that: the migration is behaviour-preserving. `scope: 'all'`
    // short-circuits before target kind is read.
    expect(authorize(OPERATOR, 'write', session('somebody-else'))).toBe('allow')
    expect(authorize(OPERATOR, 'write', { kind: 'per-user-row', userId: 'bob' })).toBe('allow')
  })

  /**
   * REVISITED AT POD-1075, AND KEPT — with the qualifier narrowed to what is
   * still true.
   *
   * POD-351 recorded that `authorize()` returns before the owner is ever read
   * when the scope is `all`, which is why its revocation tests initially passed
   * against an implementation with NO ownership check at all. Two pins carry
   * that qualifier so the claim never reads wider than its evidence, and
   * POD-1075 was named as the moment to look at them again: an ADMIN is a real
   * scoped user, not an unconstrained operator.
   *
   * WHAT CHANGED: a first admin now EXISTS as a row, with `role = 'admin'` and
   * `FIRST_ADMIN_USER_ID` as its id.
   *
   * WHAT DID NOT: the short-circuit, and deliberately. `OPERATOR` is
   * `admin`/`all`, and the two halves of that are independent gates — the
   * ACCOUNT role (`admin`, an instance-level fact about a person, ADR 9 D1.4)
   * and the CAPABILITY scope (`all`, what this call may reach). Narrowing the
   * scope to `owned` is what makes an admin a scoped user, and it is an
   * ENFORCEMENT change: ADR 9 D1.5 says `OPERATOR` *"survives only as a
   * migration artefact"* and ADR 9's compliance checklist requires that no code
   * path construct an unconstrained capability from "someone authenticated" —
   * but the thing that would have to stop doing so is `resolvePrincipal`, and
   * it cannot until the transport can tell two humans apart. That is Phase 3
   * (POD-315/POD-290), and this issue's brief excludes authz enforcement in as
   * many words.
   *
   * So the pins stay, and this test says what they are now pinning: not "there
   * are no users" — there are — but "the shared-password transport still mints
   * one unconstrained capability".
   */
  it('is the FIRST ADMIN’s reach, and the scope — not the role — is what is unconstrained', () => {
    expect(OPERATOR.role).toBe('admin')
    expect(OPERATOR.scope).toEqual({ kind: 'all' })

    // The counterfactual that keeps the short-circuit honest: the SAME admin
    // role, scoped to what it owns, does NOT reach somebody else's entity. So
    // the reach above is the scope talking, and flipping `resolvePrincipal` to
    // mint an `owned` scope is all that stands between here and a scoped admin.
    const scopedAdmin: Capability = { role: 'admin', scope: { kind: 'owned', userId: asUserId('user:sole') } }
    expect(authorize(scopedAdmin, 'write', session('somebody-else'))).toBe('forbidden')
    expect(authorize(scopedAdmin, 'write', session('user:sole'))).toBe('allow')
  })
})
