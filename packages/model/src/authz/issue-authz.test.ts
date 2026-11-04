import { describe, expect, it } from 'vitest'
import { asIssueId, asSessionId, asUserId } from '../ids/brands'
import { type AuthDecision, authorize, type Capability, type IssueScope } from './issue-authz'

/**
 * A member id, as a FIXTURE (A2). This package has no database and opens no
 * instance, so `firstAdminMemberId()` — which resolves the earliest admin member
 * of an open one — has no answer here and would throw. These tests never needed
 * the real first admin: they need A person, and naming one locally says so.
 */
const A_MEMBER = asUserId('mem_0ujtsYcgvSTl8PAuAdqWYSMnLOv')

/**
 * The unconstrained admin capability, CONSTRUCTED HERE.
 *
 * It used to be `OPERATOR`, exported from this module. POD-333 deleted that
 * export — no production code read it, and a model-level export nothing in the
 * model constructs is a shim — and moved the fixture to
 * apps/server/src/test-support/capabilities.ts for the server suites. This file
 * tests `authorize()` itself, so it builds its own subject rather than importing
 * one from a layer above.
 */
const UNCONSTRAINED_ADMIN: Capability = {
  role: 'admin',
  scope: { kind: 'all' },
  actorUser: A_MEMBER,
  onBehalfOf: A_MEMBER,
}
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
    expect(authorize(UNCONSTRAINED_ADMIN, 'manage', { id: 'i1' })).toBe('allow')
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
    expect(
      authorize(cap({ kind: 'subtree', rootId: asIssueId('root') }), 'read', { id: 'i1' }),
    ).toBe('allow')
    expect(authorize(UNCONSTRAINED_ADMIN, 'read', { id: 'i1' })).toBe('allow')
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
    // POD-6288: a legacy persisted `all` is the member rule, and a task is the
    // shared class every member writes (design §2.2, §4.1).
    all: 'allow',
    none: 'confirm-required',
    subtree: 'confirm-required',
    // A member's own scope reaches every task (POD-6288).
    owned: 'allow',
    // A self capability reaches only its own per-user row: 'forbidden' for an
    // issue target rather than 'confirm-required' — deliberately NOT
    // overridable, because `--outside-scope` confirms crossing an issue boundary
    // (ADR 3 D2) and must not double as a general escalation into another class.
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
    // POD-6288: no bypass. A legacy `all` is the member rule for the human the
    // capability names, and this one names none, so another person's entity
    // is refused.
    all: 'forbidden',
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

  it('the self scope is not override-liftable on an issue target', () => {
    // The claim above says "deliberately NOT overridable". This is the assertion
    // for it: without this, 'forbidden' could be a confirm-required in disguise.
    for (const kind of ['self'] as const) {
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

  // POD-6288 (found by POD-6283): per-user state is the "Self" class for every
  // member, so a member's own scope writes the member's OWN row, and still no
  // one else's (§3.3 non-grantable): a grant list cannot widen it.
  it('reaches its own per-user row and nobody else’s (§3.3 Self, non-grantable)', () => {
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('alice') })).toBe('allow')
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('bob') })).toBe('forbidden')
    expect(
      authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('bob') }, { override: true }),
    ).toBe('forbidden')
  })

  it('reads and writes every shared TASK, without a grant (design §2.2, POD-6288)', () => {
    expect(authorize(alice, 'read', { id: 'bobs-task' })).toBe('allow')
    expect(authorize(alice, 'write', { id: 'bobs-task' })).toBe('allow')
    // Lifecycle commands stay a role question: a worker cannot manage.
    expect(authorize(alice, 'manage', { id: 'bobs-task' })).toBe('forbidden')
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
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('alice') })).toBe('allow')
  })

  it('DENIES writing another principal’s row — the self-scoping property', () => {
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('bob') })).toBe('forbidden')
    expect(
      authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('bob') }, { override: true }),
    ).toBe('forbidden')
  })

  it('cannot write a SHARED entity — a self capability is not a weak owner-or-grant', () => {
    // Without this, a per-user capability could rename the session its read state
    // is about, which would make `self` an owner-or-grant scope wearing the wrong
    // name.
    expect(authorize(alice, 'write', session('alice'))).toBe('forbidden')
  })

  it('an admin ROLE does not widen a self scope — role and scope are independent gates', () => {
    const adminSelf = cap({ kind: 'self', userId: asUserId('alice') }, 'admin')
    expect(authorize(adminSelf, 'manage', { kind: 'per-user-row', userId: asUserId('bob') })).toBe(
      'forbidden',
    )
    // The counterfactual: the same admin capability CAN manage its own row, so the
    // denial above is the scope talking and not a blanket refusal.
    expect(authorize(adminSelf, 'manage', { kind: 'per-user-row', userId: asUserId('alice') })).toBe('allow')
  })
})

/**
 * NO PERSON IS UNCONSTRAINED ANY MORE (POD-6288, design §4.1). `all` stays in
 * the scope union only because `sessions.delegation` persisted it and a stored
 * row must keep parsing; nothing mints it. A parsed `all` gets exactly member
 * rights for the human the capability names: every shared task, its own
 * owned and per-user rows, and nothing of anybody else's.
 */
describe('a legacy persisted `all` is the member rule, not a bypass', () => {
  it('reaches shared tasks and its own rows, never somebody else’s', () => {
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', { id: 'any-task' })).toBe('allow')
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', session(A_MEMBER))).toBe('allow')
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', session('somebody-else'))).toBe('forbidden')
    expect(
      authorize(UNCONSTRAINED_ADMIN, 'write', { kind: 'per-user-row', userId: A_MEMBER }),
    ).toBe('allow')
    expect(
      authorize(UNCONSTRAINED_ADMIN, 'write', { kind: 'per-user-row', userId: asUserId('bob') }),
    ).toBe('forbidden')
  })

  it('an old persisted delegation with scope `all` gives admin Alice’s agent nothing on Bob’s private resources', () => {
    // The shape a `sessions.delegation` row written before POD-6288 parses to:
    // an agent session of Alice, an admin, with the old unscoped `all`.
    const alicesAgent: Capability = {
      role: 'admin',
      scope: { kind: 'all' },
      actorSessionId: asSessionId('alice-agent'),
      onBehalfOf: A_MEMBER,
    }
    const bob = asUserId('bob')
    for (const action of ['read', 'write', 'manage'] as const) {
      expect(authorize(alicesAgent, action, { kind: 'private', id: 'bobs-session', owner: bob })).toBe(
        'forbidden',
      )
      expect(authorize(alicesAgent, action, session(bob))).toBe('forbidden')
      expect(authorize(alicesAgent, action, { kind: 'per-user-row', userId: bob })).toBe('forbidden')
    }
    // The counterfactual: the same capability reaches Alice's own and shared tasks.
    expect(authorize(alicesAgent, 'write', { kind: 'private', id: 'hers', owner: A_MEMBER })).toBe('allow')
    expect(authorize(alicesAgent, 'write', { id: 'any-task' })).toBe('allow')
  })

  it('decides exactly as the member scope of the same human', () => {
    const member: Capability = { ...UNCONSTRAINED_ADMIN, scope: { kind: 'owned', userId: A_MEMBER } }
    const targets = [
      { id: 'any-task' },
      session(A_MEMBER),
      session('somebody-else'),
      session('somebody-else', [A_MEMBER]),
      session(null),
      { kind: 'per-user-row', userId: A_MEMBER },
      { kind: 'per-user-row', userId: asUserId('bob') },
    ] as const
    for (const action of ['read', 'write', 'manage'] as const) {
      for (const target of targets) {
        expect(authorize(UNCONSTRAINED_ADMIN, action, target), `${action} ${JSON.stringify(target)}`).toBe(
          authorize(member, action, target),
        )
      }
    }
  })
})
