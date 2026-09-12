import { describe, expect, it } from 'vitest'
import { asIssueId, asSessionId, asUserId } from '../ids/brands'
import { asLegacyGrant } from './axes'
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
    // WAS `allow` UNTIL A3 (PDM-129). An `all` scope is an unconstrained TASK
    // reach, and it was also being read as "may see every private row" — the
    // collapse that let an admin into any member's session, against ADR 9
    // Amendment 1 D7. A private target is now decided by ownership even here,
    // against the capability's `onBehalfOf`; `cap()` builds no attribution pair,
    // so this subject names nobody and fails closed.
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
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('alice') })).toBe('forbidden')
    expect(authorize(alice, 'write', { kind: 'per-user-row', userId: asUserId('bob') })).toBe('forbidden')
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

describe('the unconstrained admin capability keeps its reach across the new target kinds', () => {
  it('does NOT write an owned entity it does not own, nor another person’s per-user row', () => {
    // ── SUPERSEDED BY A3 (PDM-129) ────────────────────────────────────────────
    //
    // This test used to assert `allow` for both, on the grounds that `scope:
    // 'all'` short-circuits before the target kind is read and that POD-380 had
    // to be behaviour-preserving. The prose below already named the moment that
    // stops being the right answer — "that is Phase 3 (POD-315/POD-290), and
    // this issue's brief excludes authz enforcement in as many words". A3 is the
    // task whose brief includes it: *remove admin-to-private-resource bypasses*.
    //
    // ADR 9 Amendment 1 D7 is the rule — an admin may not view or drive another
    // member's session — and D13 bounds what a member may learn about another
    // member's session on a shared task to owner, title and live/idle state.
    // Neither is satisfiable while one predicate means both "unconstrained task
    // reach" and "sees everything".
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', session('somebody-else'))).toBe('forbidden')
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', { kind: 'per-user-row', userId: asUserId('bob') })).toBe(
      'forbidden',
    )
  })

  it('keeps its full reach over its OWN private rows, so the denial is ownership and not a blanket refusal', () => {
    // The counterfactual, without which the assertions above would also pass
    // against an `authorize` that had simply stopped answering for private
    // targets. `UNCONSTRAINED_ADMIN` carries `onBehalfOf: A_MEMBER`, which is
    // the branded human the call is made FOR — stamped from the authenticated
    // transport, never from a payload.
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', session(A_MEMBER))).toBe('allow')
    expect(
      authorize(UNCONSTRAINED_ADMIN, 'write', { kind: 'per-user-row', userId: asUserId(A_MEMBER) }),
    ).toBe('allow')
  })

  it('keeps its unconstrained reach over ISSUE targets, which is what an `all` scope is about', () => {
    // The narrowing is confined to PRIVATE targets. A task tree is shared
    // content (ADR 9 D4/D5 A3), and the execution charter's exposure order
    // forbids changing task delivery during phases A and B — so this arm is
    // deliberately untouched, and pinned here so a later tightening cannot be
    // mistaken for part of A3.
    expect(authorize(UNCONSTRAINED_ADMIN, 'write', { id: 'i1' })).toBe('allow')
    expect(authorize(UNCONSTRAINED_ADMIN, 'manage', { id: 'i1' })).toBe('allow')
    expect(authorize(UNCONSTRAINED_ADMIN, 'read', { id: 'i1' })).toBe('allow')
  })

  it('refuses a private target when the capability names no human at all', () => {
    // A machine or a system job has no on-behalf-of, and D21.2 makes that final.
    // Default-closed: no person named, no private row reached.
    const machineCapability: Capability = { role: 'admin', scope: { kind: 'all' } }
    expect(authorize(machineCapability, 'read', session('somebody-else'))).toBe('forbidden')
    expect(authorize(machineCapability, 'read', session(A_MEMBER))).toBe('forbidden')
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
   * `A_MEMBER` as its id.
   *
   * WHAT DID NOT, UNTIL A3: the short-circuit. The note here used to end by
   * saying the pins stay because "the thing that would have to stop doing so is
   * `resolvePrincipal`, and it cannot until the transport can tell two humans
   * apart. That is Phase 3 (POD-315/POD-290)".
   *
   * A3 (PDM-129) resolves that WITHOUT waiting for the transport, because the
   * two halves come apart more cleanly than the note assumed. `OPERATOR` is
   * `admin`/`all`, and those are independent gates — the ACCOUNT role (`admin`,
   * an instance-level fact about a person, ADR 9 D1.4) and the CAPABILITY scope
   * (`all`, what this call may reach). The bypass was never the scope being
   * wide; it was PRIVATE targets being decided by the scope at all. They are now
   * decided by the attribution pair's `onBehalfOf`, which the shared-password
   * transport already supplies correctly — so an admin keeps unconstrained reach
   * over task trees and loses it over everyone else's private rows, today,
   * rather than at the flip.
   *
   * So what this test now pins is the half that is still true: the
   * shared-password transport still mints ONE capability whose SCOPE is
   * unconstrained, and narrowing that scope remains Phase 3's to do.
   */
  it('is the FIRST ADMIN’s reach, and the scope — not the role — is what is unconstrained', () => {
    expect(UNCONSTRAINED_ADMIN.role).toBe('admin')
    expect(UNCONSTRAINED_ADMIN.scope).toEqual({ kind: 'all' })

    // The counterfactual that keeps the short-circuit honest: the SAME admin
    // role, scoped to what it owns, does NOT reach somebody else's entity. So
    // the reach above is the scope talking, and flipping `resolvePrincipal` to
    // mint an `owned` scope is all that stands between here and a scoped admin.
    const scopedAdmin: Capability = {
      role: 'admin',
      scope: { kind: 'owned', userId: asUserId('user:sole') },
    }
    expect(authorize(scopedAdmin, 'write', session('somebody-else'))).toBe('forbidden')
    expect(authorize(scopedAdmin, 'write', session('user:sole'))).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// A5.1 (PDM-245) — THE PRIVATE TARGET, AND WHY IT IS ITS OWN KIND
// ---------------------------------------------------------------------------

/**
 * ONE TARGET SHAPE WAS ANSWERING TWO INCOMPATIBLE QUESTIONS.
 *
 * `AuthTarget`'s `owned` arm carries an owner and a grant list, and `authorize`
 * decided it as owner-or-grant. Two different classes of thing arrive in that
 * shape, and the correct rule for them is not the same rule:
 *
 *   - a SHARED TASK, built by `modules/issues/access-index.ts#ownedTarget` and
 *     `modules/issues/service/reads.ts#ownedTarget` from an issue row plus the
 *     issue's grant edges. Owner-or-grant is CORRECT here and must not move:
 *     the execution charter's exposure order keeps task delivery unchanged
 *     through phases A and B, and C4 (PDM-144) replaces the predicate in one
 *     reviewed change afterwards.
 *   - a PRIVATE RESOURCE — a session, an automation, a machine, a per-user row
 *     — built by `modules/sessions/session-state/registry.ts` and
 *     `modules/sessions/rename-target-path.ts`. These are OWNER-ONLY in this
 *     release (A3-spec; ADR 9 Amendment 1 D7; architecture §10, which requires
 *     cross-user session grants to be ineffective), so owner-or-grant admitted
 *     a second human to another person's private execution.
 *
 * A rule cannot be narrowed for one and preserved for the other while both wear
 * one tag. So the private class gets its own member, and the `owned` member is
 * left to mean what it still correctly means. The grantees it carries are typed
 * `LegacyGrant` (see `./axes`) so the expression that was the defect —
 * `legacyGrants.includes(<a user id>)` — does not compile.
 */
describe('a PRIVATE target is owner-only, whatever the scope (A5.1)', () => {
  const OWNER = asUserId('alice')
  const READER = asUserId('bob')
  const THIRD_PARTY = asUserId('carol')

  const privateResource = (owner: string | null, legacyGrants?: readonly string[]) =>
    ({
      kind: 'private',
      id: 'sess_alice',
      owner,
      ...(legacyGrants ? { legacyGrants: legacyGrants.map(asLegacyGrant) } : {}),
    }) as const

  /**
   * TOTALITY, THE SAME OBLIGATION THE SCOPE TABLES ABOVE CARRY. Every declared
   * scope kind must have a stated answer for a private resource somebody else
   * owns, and every one of them is refusal — including the two that short-circuit
   * reads (`none`, `subtree`), because a private resource is not made readable by
   * the scope naming no person. That is what "owner-only, whatever the scope"
   * means, and a `Record<IssueScope['kind'], …>` makes a new scope member declare
   * its answer rather than inherit one.
   */
  const EXPECTED_READ_OF_ANOTHERS_PRIVATE_RESOURCE: Record<IssueScope['kind'], AuthDecision> = {
    all: 'forbidden',
    none: 'forbidden',
    subtree: 'forbidden',
    owned: 'forbidden',
    self: 'forbidden',
  }

  const SCOPES_FOR_READER: Record<IssueScope['kind'], IssueScope> = {
    all: { kind: 'all' },
    none: { kind: 'none' },
    subtree: { kind: 'subtree', rootId: asIssueId('elsewhere') },
    owned: { kind: 'owned', userId: READER },
    self: { kind: 'self', userId: READER },
  }

  /** The reader, named by the attribution pair as well as by the scope, so the
   *  `all` arm — which decides against `onBehalfOf` — has a person to refuse. */
  const readerCap = (scope: IssueScope): Capability => ({
    role: 'admin',
    scope,
    actorUser: READER,
    onBehalfOf: READER,
  })

  it('refuses every scope kind a private resource it does not own', () => {
    for (const [kind, expected] of Object.entries(EXPECTED_READ_OF_ANOTHERS_PRIVATE_RESOURCE)) {
      const scope = SCOPES_FOR_READER[kind as IssueScope['kind']]
      expect(authorize(readerCap(scope), 'read', privateResource(OWNER)), kind).toBe(expected)
    }
  })

  it('refuses every scope kind a private resource whose LEGACY GRANT names the reader', () => {
    // The defect, stated over the whole scope column: an edge row naming the
    // caller must not open another person's session under ANY capability.
    for (const [kind, expected] of Object.entries(EXPECTED_READ_OF_ANOTHERS_PRIVATE_RESOURCE)) {
      const scope = SCOPES_FOR_READER[kind as IssueScope['kind']]
      expect(
        authorize(readerCap(scope), 'read', privateResource(OWNER, [READER])),
        kind,
      ).toBe(expected)
    }
  })

  it('refuses a WRITE to another person’s private resource, granted or not', () => {
    for (const kind of Object.keys(SCOPES_FOR_READER) as IssueScope['kind'][]) {
      const scope = SCOPES_FOR_READER[kind]
      expect(authorize(readerCap(scope), 'write', privateResource(OWNER)), kind).toBe('forbidden')
      expect(
        authorize(readerCap(scope), 'write', privateResource(OWNER, [READER])),
        kind,
      ).toBe('forbidden')
    }
  })

  it('is not liftable by --outside-scope, which confirms a TASK crossing and nothing else', () => {
    expect(
      authorize(readerCap({ kind: 'all' }), 'read', privateResource(OWNER, [READER]), {
        override: true,
      }),
    ).toBe('forbidden')
    expect(
      authorize(readerCap({ kind: 'subtree', rootId: asIssueId('elsewhere') }), 'write',
        privateResource(OWNER, [READER]), { override: true }),
    ).toBe('forbidden')
  })

  it('refuses an UNOWNED private resource, and a grant does not supply an owner', () => {
    expect(authorize(readerCap({ kind: 'all' }), 'read', privateResource(null))).toBe('forbidden')
    expect(
      authorize(readerCap({ kind: 'all' }), 'read', privateResource(null, [READER])),
    ).toBe('forbidden')
  })

  it('refuses a capability that names no human at all (D21.2: a machine has no on-behalf-of)', () => {
    const machine: Capability = { role: 'admin', scope: { kind: 'all' } }
    expect(authorize(machine, 'read', privateResource(OWNER))).toBe('forbidden')
    expect(authorize(machine, 'read', privateResource(OWNER, [READER]))).toBe('forbidden')
  })

  it('ALLOWS THE OWNER under the scopes that name them, so the refusals are ownership talking', () => {
    // The counterfactual. Without it every assertion above would also pass against
    // an `authorize` that had simply stopped answering for private targets — the
    // guard that fails identically whether or not the thing it guards is switched
    // on. The owner is admitted while the resource carries the SAME grant list.
    const ownerCap = (scope: IssueScope): Capability => ({
      role: 'admin',
      scope,
      actorUser: OWNER,
      onBehalfOf: OWNER,
    })
    for (const scope of [
      { kind: 'all' } as const,
      { kind: 'owned', userId: OWNER } as const,
    ]) {
      expect(authorize(ownerCap(scope), 'read', privateResource(OWNER)), scope.kind).toBe('allow')
      expect(authorize(ownerCap(scope), 'write', privateResource(OWNER)), scope.kind).toBe('allow')
      expect(
        authorize(ownerCap(scope), 'read', privateResource(OWNER, [READER, THIRD_PARTY])),
        scope.kind,
      ).toBe('allow')
    }
  })

  it('still answers the ROLE gate first, so a private target cannot widen an action', () => {
    // A viewer owns the resource and still may not manage it: the private contract
    // is an ownership answer bolted onto the role table, not a replacement for it.
    const owningViewer: Capability = {
      role: 'viewer',
      scope: { kind: 'all' },
      actorUser: OWNER,
      onBehalfOf: OWNER,
    }
    expect(authorize(owningViewer, 'read', privateResource(OWNER))).toBe('allow')
    expect(authorize(owningViewer, 'write', privateResource(OWNER))).toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// A5.1 — the `owned` target under an UNCONSTRAINED scope
// ---------------------------------------------------------------------------

/**
 * WHY THE `all` ARM READS AN OWNED TARGET AS PRIVATE.
 *
 * A3 gave the `all` scope an ownership rule for `owned` targets, and left the
 * grant clause in it. Under `all` that clause is unreachable by any TASK: the
 * server's `checkIssueAccess` returns before the target is built when the scope
 * is `all`, and `mayReadOwned` always mints an `owned` SCOPE — so the only live
 * producers of an `owned` target under an unconstrained capability are
 * `session-state/registry.ts` and `rename-target-path.ts`, and both build
 * SESSIONS. The arm was a private-resource path wearing the task target's name.
 *
 * So it is decided as private until those two producers are repointed at the
 * `private` member, which is the later integration sweep's to do. The `owned`
 * arm under an `owned` SCOPE is NOT changed with it — there the same shape does
 * still carry issues, and narrowing it would move task exposure.
 */
describe('an owned target under an unconstrained scope is owner-only (A5.1)', () => {
  const ADMIN_GRANTEE: Capability = {
    role: 'admin',
    scope: { kind: 'all' },
    actorUser: A_MEMBER,
    onBehalfOf: A_MEMBER,
  }

  it('refuses an admin whom a grant edge names on someone else’s session', () => {
    expect(authorize(ADMIN_GRANTEE, 'read', session('somebody-else', [A_MEMBER]))).toBe('forbidden')
    expect(authorize(ADMIN_GRANTEE, 'write', session('somebody-else', [A_MEMBER]))).toBe(
      'forbidden',
    )
  })

  it('keeps that admin’s reach over what they OWN, grant list and all', () => {
    // The counterfactual for the refusals above.
    expect(authorize(ADMIN_GRANTEE, 'write', session(A_MEMBER, [A_MEMBER]))).toBe('allow')
    expect(authorize(ADMIN_GRANTEE, 'write', session(A_MEMBER))).toBe('allow')
  })

  it('LEAVES THE OWNER-OR-GRANT TASK RULE ALONE under an owned scope', () => {
    // THE SCOPE BOUNDARY OF THIS ISSUE, AS AN ASSERTION. The same target shape
    // under an `owned` scope still carries issues — `access-index.ts#ownedTarget`
    // builds one from an issue row and the issue's grant edges — so a grantee
    // still reads and writes what they were granted. Narrowing this would change
    // what a member can see of a task, which the charter's exposure order puts
    // after phase B and gives to C4 (PDM-144).
    const alice = cap({ kind: 'owned', userId: asUserId('alice') })
    expect(authorize(alice, 'read', session('bob', ['alice']))).toBe('allow')
    expect(authorize(alice, 'write', session('bob', ['alice']))).toBe('allow')
    expect(authorize(alice, 'read', session('bob'))).toBe('forbidden')
  })
})
