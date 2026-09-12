/**
 * THE FOUR-AXIS ALLOW/DENY TABLES (A3/PDM-129).
 *
 * These are the properties that make the separation real rather than stylistic.
 * The suite is organised around the two acceptance criteria it has to hold —
 * MU-02 (a forged identity cannot bypass role/resource policy) and MU-06 (a
 * broader agent scope cannot) — plus the four regressions that would silently
 * re-collapse the axes.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: anything about two live humans on one
 * transport. `auth-store.ts` is still one password per instance, so the
 * transports cannot yet tell two people apart. These tables drive the POLICY
 * layer with the facts the transports WILL supply, which is the only way an
 * ownership rule can be tested before login lands — and exactly the ordering ADR
 * 3 Amendment 1's rejected-alternatives table demands, since the opposite order
 * leaves every ownership check dead code until the flip.
 */

import { describe, expect, it } from 'vitest'
import { asUserId } from '../ids/brands'
import {
  activeIdentityDecision,
  type AxisDecision,
  AUTHORIZATION_AXES,
  delegationIsResolvable,
  type IdentityFacts,
  intersectDelegation,
  MAX_DELEGATION_DEPTH,
  meetsRoleFloor,
  privateExecutionDecision,
  taskCollaborationDecision,
  taskScopeDecision,
} from './axes'

const ALICE = asUserId('mem_alice')
const BOB = asUserId('mem_bob')

const member = (userId = ALICE): IdentityFacts => ({ userId, role: 'member', disabledAt: null })
const admin = (userId = BOB): IdentityFacts => ({ userId, role: 'admin', disabledAt: null })
const suspended = (userId = ALICE): IdentityFacts => ({
  userId,
  role: 'admin',
  disabledAt: '2026-09-01T00:00:00.000Z',
})

// ---------------------------------------------------------------------------
// Axis 1 — active identity
// ---------------------------------------------------------------------------

describe('axis 1 · active identity', () => {
  const table: ReadonlyArray<[string, IdentityFacts | undefined, AxisDecision]> = [
    ['an active member', member(), 'allow'],
    ['an active admin', admin(), 'allow'],
    ['a suspended admin', suspended(), 'deny'],
    ['an identity the directory cannot resolve', undefined, 'deny'],
  ]
  for (const [label, facts, expected] of table) {
    it(`${label} → ${expected}`, () => {
      expect(activeIdentityDecision(facts)).toBe(expected)
    })
  }

  it('denies a suspended ADMIN, so grade cannot outrank suspension', () => {
    // The ordering claim in the module header, as a test: suspension is
    // evaluated before grade, so "admin" never reaches a later axis to be
    // consulted. D14 makes "suspended" the existing disabled state, and D12
    // keeps the person's rows — suspension removes the ability to ACT.
    expect(activeIdentityDecision(suspended())).toBe('deny')
    expect(taskCollaborationDecision(suspended(), { kind: 'shared-content' })).toBe('deny')
    expect(
      privateExecutionDecision(suspended(), { resourceId: 's1', owner: ALICE }),
    ).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Axis 2 — human role
// ---------------------------------------------------------------------------

describe('axis 2 · human role', () => {
  it('admits both grades to a member floor and only admin to an admin floor', () => {
    expect(meetsRoleFloor(member(), 'member')).toBe(true)
    expect(meetsRoleFloor(admin(), 'member')).toBe(true)
    expect(meetsRoleFloor(member(), 'admin')).toBe(false)
    expect(meetsRoleFloor(admin(), 'admin')).toBe(true)
  })

  it('is a floor on ATTEMPTS and says nothing about rows', () => {
    // The sentence that separates axis 2 from axis 4, as a property. An admin
    // clears every role floor and still cannot reach another member's private
    // resource — which is the bypass this issue removed.
    const theAdmin = admin()
    expect(meetsRoleFloor(theAdmin, 'admin')).toBe(true)
    expect(
      privateExecutionDecision(theAdmin, { resourceId: 'sess_alice', owner: ALICE }),
    ).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Axis 3 — task collaboration
// ---------------------------------------------------------------------------

describe('axis 3 · task collaboration', () => {
  it('lets any active member edit ordinary shared task content', () => {
    // ADR 9 D4/D5 A3. Participation records are not editor grants, which is why
    // the evaluator takes none.
    expect(taskCollaborationDecision(member(), { kind: 'shared-content' })).toBe('allow')
    expect(taskCollaborationDecision(admin(), { kind: 'shared-content' })).toBe('allow')
  })

  it('restricts a comment edit to its author, admin included', () => {
    const comment = { kind: 'comment' as const, authorId: ALICE }
    expect(taskCollaborationDecision(member(ALICE), comment)).toBe('allow')
    expect(taskCollaborationDecision(member(BOB), comment)).toBe('deny')
    // The admin arm that does not exist: a comment is a person's own utterance.
    expect(taskCollaborationDecision(admin(BOB), comment)).toBe('deny')
  })

  it('lets nobody edit an unattributed comment', () => {
    // Default-closed on an author-only rule: an utterance whose author is
    // unknown is not anyone's to rewrite, and "unknown" must not read as "mine".
    expect(taskCollaborationDecision(admin(), { kind: 'comment', authorId: null })).toBe('deny')
    expect(taskCollaborationDecision(member(), { kind: 'comment', authorId: null })).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Axis 3, scope half — the confinement of `--outside-scope`
// ---------------------------------------------------------------------------

describe('axis 3 · outside-scope confirmation is confined to task scope', () => {
  it('confirms a crossing and allows it when confirmed', () => {
    expect(taskScopeDecision(true)).toBe('allow')
    expect(taskScopeDecision(false)).toBe('confirm-required')
    expect(taskScopeDecision(false, { override: true })).toBe('allow')
  })

  it('is the ONLY evaluator that can return confirm-required', () => {
    // The structural claim. If any other axis could return `confirm-required`,
    // then a caller passing `--outside-scope` to a general `authorize` would
    // convert that refusal into an allow — including, once ownership decisions
    // became three-valued, a refusal to reach another member's private session.
    const outcomes: AxisDecision[] = [
      activeIdentityDecision(member()),
      activeIdentityDecision(suspended()),
      activeIdentityDecision(undefined),
      taskCollaborationDecision(member(), { kind: 'shared-content' }),
      taskCollaborationDecision(member(BOB), { kind: 'comment', authorId: ALICE }),
      privateExecutionDecision(member(), { resourceId: 'r', owner: ALICE }),
      privateExecutionDecision(member(BOB), { resourceId: 'r', owner: ALICE }),
      privateExecutionDecision(member(), { resourceId: 'r', owner: null }),
    ]
    expect(outcomes).not.toContain('confirm-required')
  })

  it('cannot be handed an identity, an owner or a role', () => {
    // Enforced by the signature rather than by this assertion — the test records
    // the property so that widening the parameter list is a visible change to a
    // stated rule and not a quiet convenience.
    expect(taskScopeDecision.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Axis 4 — private execution
// ---------------------------------------------------------------------------

describe('axis 4 · private execution', () => {
  const resource = { resourceId: 'sess_alice', owner: ALICE }

  it('allows the owner and denies everyone else', () => {
    expect(privateExecutionDecision(member(ALICE), resource)).toBe('allow')
    expect(privateExecutionDecision(member(BOB), resource)).toBe('deny')
  })

  it('DENIES AN ADMIN who is not the owner (ADR 9 Amendment 1 D7)', () => {
    // The regression this whole issue is about. Before A3 the answer here was
    // `allow`, because `userCommandPrincipal` mints `scope: 'all'` for an admin
    // and `scope.kind === 'all'` was also the answer to "may I see everything?".
    expect(privateExecutionDecision(admin(BOB), resource)).toBe('deny')
  })

  it('refuses an unowned resource rather than treating it as ambient', () => {
    // §3.1.1 default-closed. Two modules once spelled this rule over a
    // possibly-absent owner, so an unowned row plus an unauthenticated reader
    // compared `undefined === undefined` and read as ALLOW.
    expect(privateExecutionDecision(admin(), { resourceId: 'r', owner: null })).toBe('deny')
    expect(privateExecutionDecision(member(), { resourceId: 'r', owner: null })).toBe('deny')
  })

  it('honours an explicit grant and nothing else', () => {
    expect(
      privateExecutionDecision(member(BOB), { ...resource, grants: [BOB] }),
    ).toBe('allow')
    expect(
      privateExecutionDecision(member(BOB), { ...resource, grants: [] }),
    ).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Axis 5 — agent delegation (MU-06)
// ---------------------------------------------------------------------------

describe('axis 5 · agent delegation intersects and never widens', () => {
  const outcomes: readonly AxisDecision[] = ['allow', 'deny', 'confirm-required']

  it('never returns a decision broader than its human half', () => {
    // MU-06 as a property over the whole cross-product rather than three
    // examples: there is no agent decision that turns a human `deny` into
    // anything else, and none that turns `confirm-required` into `allow`.
    const rank: Record<AxisDecision, number> = { deny: 0, 'confirm-required': 1, allow: 2 }
    for (const human of outcomes) {
      for (const agent of outcomes) {
        expect(rank[intersectDelegation(human, agent)]).toBeLessThanOrEqual(rank[human])
      }
    }
  })

  it('denies whenever either half denies', () => {
    for (const other of outcomes) {
      expect(intersectDelegation('deny', other)).toBe('deny')
      expect(intersectDelegation(other, 'deny')).toBe('deny')
    }
  })

  it('allows only when both halves allow', () => {
    expect(intersectDelegation('allow', 'allow')).toBe('allow')
    expect(intersectDelegation('allow', 'confirm-required')).toBe('confirm-required')
    expect(intersectDelegation('confirm-required', 'allow')).toBe('confirm-required')
  })

  it('is commutative, so neither half is privileged', () => {
    for (const a of outcomes) {
      for (const b of outcomes) {
        expect(intersectDelegation(a, b)).toBe(intersectDelegation(b, a))
      }
    }
  })

  it('refuses a chain at the depth ceiling rather than answering from where it stopped', () => {
    // A cycle in `spawnedBy` must not resolve to whatever session the walk
    // happened to halt on — that would be a delegator nobody granted.
    expect(delegationIsResolvable({ onBehalfOf: ALICE, chainDepth: 0 })).toBe(true)
    expect(
      delegationIsResolvable({ onBehalfOf: ALICE, chainDepth: MAX_DELEGATION_DEPTH - 1 }),
    ).toBe(true)
    expect(
      delegationIsResolvable({ onBehalfOf: ALICE, chainDepth: MAX_DELEGATION_DEPTH }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The separation itself
// ---------------------------------------------------------------------------

describe('the axes are separate questions', () => {
  it('names exactly the five the charter asks for', () => {
    expect([...AUTHORIZATION_AXES]).toEqual([
      'active-identity',
      'human-role',
      'task-collaboration',
      'private-execution',
      'agent-delegation',
    ])
  })

  it('gives different answers to different questions about one principal', () => {
    // The single principal that used to get one answer to all of these. An admin
    // who is not the owner: admits every command by grade, may edit shared task
    // content, may NOT edit someone else's comment, may NOT reach their private
    // session. Four questions, four answers, one person.
    const theAdmin = admin(BOB)
    expect(meetsRoleFloor(theAdmin, 'admin')).toBe(true)
    expect(taskCollaborationDecision(theAdmin, { kind: 'shared-content' })).toBe('allow')
    expect(taskCollaborationDecision(theAdmin, { kind: 'comment', authorId: ALICE })).toBe('deny')
    expect(
      privateExecutionDecision(theAdmin, { resourceId: 'sess_alice', owner: ALICE }),
    ).toBe('deny')
  })
})
