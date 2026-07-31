import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { asMatrixRowId, visibilityClassOf } from '../annotations/ownership'
import { ROW } from '../annotations/matrix'
import { Attribution } from '../fields/attribution'
import { Ownership } from '../fields/ownership'
import { ClientSessionAggregate } from '../identity/client-session'
import { UserAccount } from '../identity/user'
import { IssueAggregate } from './issue'
import { SESSION_IMMUTABLE_AFTER_CREATE, SessionAggregate } from './session'
import {
  type CanonicalAggregate,
  CANONICAL_AGGREGATES,
  aggregateVisibilityOf,
  classificationViolations,
  PER_USER_STATE_KEYS,
} from './registry'

/**
 * The FIXTURE the default-closed rule is proved against.
 *
 * A real, complete-looking aggregate that simply never got a matrix row — which
 * is what the mistake looks like in practice. Nobody writes `visibility:
 * undefined`; they add a class and forget ADR 1's matrix.
 */
const UNCLASSIFIED_FIXTURE: CanonicalAggregate = {
  name: 'FixtureWidget',
  schema: z.object({ widgetId: z.string(), label: z.string() }),
  matrixRow: asMatrixRowId('fixture-widget-not-in-the-matrix'),
  visibility: 'personal',
}

describe('default-closed classification: an unclassified aggregate FAILS', () => {
  it('passes the real registry — both canonical aggregates are classified', () => {
    expect(classificationViolations()).toEqual([])
  })

  it('FAILS a fixture aggregate whose class was never declared on the matrix', () => {
    // The counterfactual is in the fixture set, not just the assertion: the two
    // real aggregates are present and pass, so a check that flagged everything
    // (or nothing) could not produce this result.
    const violations = classificationViolations([...CANONICAL_AGGREGATES, UNCLASSIFIED_FIXTURE])

    expect(violations.map((v) => v.aggregate)).toEqual(['FixtureWidget'])
    expect(violations[0]?.kind).toBe('no-matrix-row')
    expect(violations[0]?.detail).toContain('not in the ownership matrix')
  })

  it('FAILS an aggregate that declares itself tenant-visible against a personal row', () => {
    // The exposure case, and the reason a required `visibility` field is not
    // enough on its own: this declaration is well-typed and wrong.
    const overclaiming: CanonicalAggregate = {
      name: 'OverclaimingSession',
      schema: SessionAggregate,
      matrixRow: ROW.sessionIdentity,
      visibility: 'deployment-substrate',
    }

    const violations = classificationViolations([overclaiming])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('declaration-disagrees-with-matrix')
    expect(violations[0]?.detail).toContain("resolves row 'session-identity' to 'personal'")
  })

  it('resolves an unregistered aggregate to personal — the semantic backstop', () => {
    // Holds with every test above deleted (model README invariant 4): the
    // default is a total function, not a thrown error a caller could catch and
    // treat as permissive.
    expect(aggregateVisibilityOf('NeverRegistered')).toBe('personal')
    expect(aggregateVisibilityOf('FixtureWidget')).toBe('personal')
  })

  /**
   * THE REGISTRY MEMBERSHIP PIN — and the reason it exists.
   *
   * `aggregateVisibilityOf('Session') === 'personal'` is TRUE WHETHER OR NOT
   * `Session` is registered, because the default-closed fallback returns
   * `personal` for anything it has never heard of. So a test asserting only
   * that could not tell a correct declaration from a total absence.
   *
   * Found by mutation (POD-367's rule: prove the instrument can say YES before
   * believing it say NO). MUTANT E deleted the whole `Session` entry from
   * `CANONICAL_AGGREGATES` and the suite stayed GREEN — and the test COUNT
   * silently fell from 27 to 24, because every `it.each(CANONICAL_AGGREGATES)`
   * quietly iterated one fewer case. Coverage evaporating without a red is the
   * worse half of that finding.
   */
  it('actually REGISTERS every aggregate — not merely resolves them by default', () => {
    expect(CANONICAL_AGGREGATES.map((a) => a.name).sort()).toEqual([
      'ClientSession',
      'Grant',
      'Issue',
      'Session',
      'User',
      'UserCredential',
    ])
  })

  it('reads the DECLARED class, not the default — shown with a non-personal one', () => {
    // The counterfactual the default-closed fallback otherwise hides. If
    // `aggregateVisibilityOf` ignored the registry and always returned the
    // default, this would answer `personal` and fail.
    const declaredSubstrate = [
      { ...CANONICAL_AGGREGATES[0]!, name: 'Substrateish', visibility: 'deployment-substrate' },
    ] as const

    expect(aggregateVisibilityOf('Substrateish', declaredSubstrate)).toBe('deployment-substrate')
    // …and the same lookup still falls closed for a name that is not in it.
    expect(aggregateVisibilityOf('Session', declaredSubstrate)).toBe('personal')
  })

  it('classifies each canonical aggregate as the matrix does, and none as substrate', () => {
    // Meaningful only alongside the two tests above: the membership pin proves
    // they are registered, and the counterfactual proves the function reads the
    // declaration rather than returning the default regardless.
    //
    // Three DIFFERENT answers, which is the point of asserting them one by one
    // rather than looping "is it personal": if the resolver ignored the registry
    // and returned the default, `UserCredential` and `ClientSession` would come
    // back `personal` and this would fail. A suite in which every expected value
    // equals the default cannot tell a declaration from an absence.
    expect(aggregateVisibilityOf('Session')).toBe('personal')
    expect(aggregateVisibilityOf('Issue')).toBe('personal')
    expect(aggregateVisibilityOf('User')).toBe('personal')
    expect(aggregateVisibilityOf('Grant')).toBe('personal')
    expect(aggregateVisibilityOf('UserCredential')).toBe('secret')
    expect(aggregateVisibilityOf('ClientSession')).toBe('per-user-state')

    // The tenant-visible floor is deliberately small (readiness §3.1.1): nothing
    // this package declares canonical is substrate.
    for (const agg of CANONICAL_AGGREGATES) {
      expect(agg.visibility).not.toBe('deployment-substrate')
    }
  })

  /**
   * THE POD-731 REFINEMENT, applied here.
   *
   * `visibilityClassOf` is TOTAL and default-closed, so a MISTYPED matrix row id
   * also resolves `personal` — which means an aggregate that declares `personal`
   * against a row that does not exist passes the agreement check and is caught
   * only by the separate missing-row check. Asserting that every registered
   * aggregate's row is really ON the matrix is therefore a distinct obligation,
   * and this demonstrates the backstop firing on one that is not.
   */
  it('every registered row id is really on the matrix — with the backstop shown firing', () => {
    expect(classificationViolations(CANONICAL_AGGREGATES).filter((v) => v.kind === 'no-matrix-row'))
      .toEqual([])

    // The demonstration: a typo in the row id, with a declaration that AGREES
    // with what the default-closed resolver answers for it. The agreement check
    // is silent — proved below — and only the membership check catches it.
    const typo: CanonicalAggregate = {
      name: 'UserWithTypoRow',
      schema: UserAccount,
      matrixRow: asMatrixRowId('user-acount'),
      visibility: 'personal',
    }
    const violations = classificationViolations([typo])

    expect(violations.map((v) => v.kind)).toEqual(['no-matrix-row'])
    // …and this is why it is a separate obligation: the resolver is perfectly
    // happy, because default-closed means "never heard of it" answers `personal`.
    expect(visibilityClassOf('user-acount')).toBe('personal')
  })
})

describe('per-user state is absent from the canonical aggregates', () => {
  it.each(CANONICAL_AGGREGATES)('$name carries no per-user singleton', ({ schema }) => {
    const present = PER_USER_STATE_KEYS.filter((k) => k in schema.shape)
    expect(present).toEqual([])
  })

  it('DETECTS a per-user singleton put back on a canonical aggregate', () => {
    // Proves the check above is an instrument and not a tautology: the same
    // predicate, over a shape that does carry `readAt`, must fail.
    const regressed: CanonicalAggregate = {
      name: 'SessionWithReadAt',
      schema: SessionAggregate.extend({ readAt: z.string().nullable() }),
      matrixRow: ROW.sessionIdentity,
      visibility: 'personal',
    }

    const violations = classificationViolations([regressed])

    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('per-user-state-member')
    expect(violations[0]?.detail).toContain('readAt')
  })
})

describe('the aggregates carry ownership and attribution, and not their alternatives', () => {
  /**
   * WHICH CLASSES CARRY `Ownership`, AND WHY IT IS NOT ALL OF THEM.
   *
   * "Every canonical aggregate composes Ownership" was true while the only two
   * were `personal`, and it stops being true the moment the identity classes
   * arrive — not because they were skipped, but because ADR 1's matrix declares
   * that they have no owner column to carry:
   *
   *   - `secret` (`UserCredential`): the matrix row's owner rule is literally
   *     `{ kind: 'none', reason: 'secret' }`, with the reasoning spelled out —
   *     credential material AUTHENTICATES a person but is not theirs to grant or
   *     transfer, and giving it an owner would imply transfer semantics for
   *     credentials. An `owner` key here would be the wrong claim, not a missing
   *     one.
   *   - `per-user-state` (`ClientSession`): the owner resolves
   *     `the-user-in-the-key`, so the row's `user` IS its owner. A second owner
   *     column that could differ from it would make a non-grantable class
   *     shareable by accident (ADR 9 D3 rule 4).
   *
   * So the expectation is keyed on the DECLARED CLASS, and the negative half is
   * asserted as loudly as the positive one — a test that only checked "personal
   * classes have an owner" would pass just as happily if the credential grew
   * one.
   */
  it.each(CANONICAL_AGGREGATES)('$name composes Ownership iff its class has an owner', ({
    schema,
    visibility,
  }) => {
    const ownershipKeys = Object.keys(Ownership.shape)
    const carried = ownershipKeys.filter((k) => k in schema.shape)

    switch (visibility) {
      case 'personal':
      case 'owned-compute':
        expect(carried.sort()).toEqual(ownershipKeys.sort())
        break
      case 'secret':
      case 'per-user-state':
      case 'deployment-substrate':
        expect(carried).toEqual([])
        break
    }
  })

  it('the per-user-state class carries its user in the key instead of an owner', () => {
    // The other half of the negative above: `ClientSession` has no `owner`, and
    // that is only correct because it has a `user`. Without this, "no owner" and
    // "no idea whose it is" would be indistinguishable.
    expect(ClientSessionAggregate.shape).toHaveProperty('user')
    expect(ClientSessionAggregate.shape).not.toHaveProperty('owner')
  })

  it.each(CANONICAL_AGGREGATES)('$name carries the attribution PAIR, unsplit', ({
    name,
    schema,
  }) => {
    // WHICH KEY holds the pair differs by class, and the list is exhaustive over
    // the registry so a new aggregate cannot join without declaring one. A
    // `.filter()` over "the ones that have createdBy" would have let the two
    // classes that lack it pass by not being looked at.
    const PAIR_KEY: Record<string, string | null> = {
      Session: 'createdBy',
      Issue: 'createdBy',
      User: 'createdBy',
      Grant: 'createdBy',
      // Written by the login path and by the migration, never by a person or an
      // agent acting for one: a device row's attribution is the `user` it
      // resolves to, and a `createdBy` beside it would be a second, weaker
      // answer to the same question.
      ClientSession: null,
      // `secret`, `replication: 'none'`: it never leaves the server and never
      // enters the outbox, so there is no replicated write to attribute.
      UserCredential: null,
    }
    const expected = PAIR_KEY[name]
    // `undefined` means this aggregate is not in the table at all — a new
    // registry member that never declared where its pair lives. Failing here is
    // the point: the table is exhaustive over the registry by assertion, not by
    // a `.filter()` that would let an undeclared class pass by not being looked
    // at.
    expect(expected === undefined).toBe(false)

    if (expected === null || expected === undefined) {
      expect(schema.shape).not.toHaveProperty('createdBy')
      return
    }
    expect((schema.shape as Record<string, unknown>)[expected]).toBeDefined()

    // The pair is a pair: both halves, on one object. A shape carrying only an
    // actor would satisfy "has attribution" and violate ADR 9 D5 A3.
    const parsed = Attribution.safeParse({ actor: { kind: 'system', job: 'steward' } })
    expect(parsed.success).toBe(false)
  })

  it('carries NO provenance keys — those ride the envelope (ADR 4 D3.8/D9.4)', () => {
    for (const { schema } of CANONICAL_AGGREGATES) {
      expect(schema.shape).not.toHaveProperty('viaHub')
      expect(schema.shape).not.toHaveProperty('upstreamStale')
      expect(schema.shape).not.toHaveProperty('pendingSync')
    }
  })

  it('carries NO instance partition — multi-user is not multi-tenancy (ADR 1 D5)', () => {
    for (const { schema } of CANONICAL_AGGREGATES) {
      for (const key of Object.keys(schema.shape)) {
        expect(key.toLowerCase()).not.toContain('instanceid')
        expect(key.toLowerCase()).not.toContain('tenant')
      }
    }
  })

  it('carries NO obviously-named effective capability (ADR 9 D5 A1)', () => {
    // Rights are resolved LIVE at apply time; a snapshot survives the
    // revocation of the person it came from, with no reaper to trigger.
    //
    // A NAME MATCHER, and only that — the same class of instrument as
    // POD-643's exported `findCapabilitySnapshotKeys`, with the same blind
    // spot: an authority-shaped value under an innocent key (`meta`, `ctx`,
    // `extra`) is invisible to both. It is kept for its failure MESSAGE, which
    // names the offending key; the key-set pin below is what actually closes
    // the gap. Two instruments, and neither is the other's corroboration.
    for (const { schema } of CANONICAL_AGGREGATES) {
      for (const key of Object.keys(schema.shape)) {
        const k = key.toLowerCase()
        expect(k).not.toContain('capability')
        expect(k).not.toContain('effectiverights')
        expect(k).not.toContain('permissions')
      }
    }
  })
})

/**
 * THE EXACT KEY SETS, pinned.
 *
 * This is the instrument the name matchers above cannot be: it fails on ANY new
 * key, however innocently named, so an authority-shaped value smuggled in as
 * `meta` or `ctx` reds here even though no name-based detector would see it
 * (POD-643's caveat on `findCapabilitySnapshotKeys`, adopted).
 *
 * It is deliberately a chore to update. These two lists are the canonical
 * durable vocabulary of the whole product; growing one should be a deliberate
 * act with a reviewer looking at the diff, not a side effect of extending a
 * field group. When this test fails on an intended addition, the fix is to add
 * the key here AND to satisfy yourself that it is durable truth — not live
 * state (D3.7), not derived (D3.6), not per-user (D10), not provenance (D3.8),
 * and not a snapshotted right (ADR 9 D5 A1).
 */
const SESSION_AGGREGATE_KEYS = [
  'accountId', 'activityCount', 'agentKind', 'agentState', 'archived', 'createdAt',
  'createdBy', 'cwd', 'deleted', 'durableLabel', 'effort', 'executionProfileId',
  'exitCode', 'headless', 'inputCount', 'issueId', 'lastActiveAt', 'lastInputAt',
  'lastOutputAt', 'lastResumedAt', 'machineId', 'model', 'name', 'nameSource',
  'namedBy', 'origin', 'outputCount', 'owner', 'refDraft', 'refIssueId', 'refLetter',
  'resume', 'sessionId', 'spawnFailure', 'spawnedBy', 'status', 'stopReason',
  'stoppedAt', 'title', 'visibility', 'workState', 'workflowRunId', 'workflowStepId',
]

const ISSUE_AGGREGATE_KEYS = [
  'acceptance', 'activityNotes', 'archived', 'asked', 'assignee', 'audience',
  'blockedByNotes', 'branch', 'brief', 'closedAt', 'closedReason', 'color',
  'coordinatorSessionId', 'createdAt', 'createdBy', 'defaultAgent', 'defaultEffort',
  'defaultModel', 'deferUntil', 'deletedAt', 'dependencyNote', 'description', 'design',
  'dueAt', 'duplicateOf', 'estimateMin', 'id', 'intentOrigin', 'isDraftVessel', 'labels',
  'lastLifecycleActor', 'linearId', 'linearIdentifier', 'linearUrl', 'machineId',
  'needsHuman', 'notes', 'notesUpdatedAt', 'owner', 'panel', 'parentBranch', 'parentId',
  'prUrl', 'priority', 'repoId', 'revision', 'seq', 'sortKey', 'stage', 'startedBySession',
  'suggestedReason', 'suggestedStage', 'supersededBy', 'title', 'type', 'updatedAt',
  'visibility', 'worktreePath',
]

describe('the canonical key sets are pinned exactly', () => {
  it('SessionAggregate carries exactly these 43 keys and no others', () => {
    expect(Object.keys(SessionAggregate.shape).sort()).toEqual(SESSION_AGGREGATE_KEYS)
  })

  it('IssueAggregate carries exactly these 58 keys and no others', () => {
    expect(Object.keys(IssueAggregate.shape).sort()).toEqual(ISSUE_AGGREGATE_KEYS)
  })

  it('catches an authority-shaped value hidden under an INNOCENT key', () => {
    // The case neither name matcher can see, and the reason the pin exists.
    // `meta` names nothing suspicious; its CONTENT is a frozen grant set, which
    // is the privilege leak ADR 9 D5 A1 rejects.
    const smuggled = SessionAggregate.extend({
      meta: z.object({ allowedVerbs: z.array(z.string()), grantedBy: z.string() }),
    })

    expect(Object.keys(smuggled.shape).sort()).not.toEqual(SESSION_AGGREGATE_KEYS)

    // …and prove the name matcher genuinely MISSES it, so the two instruments
    // are demonstrably not corroborating each other.
    const nameMatcherHits = Object.keys(smuggled.shape).filter((k) => {
      const lower = k.toLowerCase()
      return (
        lower.includes('capability') ||
        lower.includes('effectiverights') ||
        lower.includes('permissions')
      )
    })
    expect(nameMatcherHits).toEqual([])
  })
})

describe('live-only and derived fields stay OFF the durable aggregate', () => {
  it('excludes D-9’s five column-less SessionMeta fields (ADR 4 D3.7)', () => {
    // These are published on the wire today and have NO storage column in any
    // migration, which is why they belong to SessionLiveOverlay.
    for (const key of [
      'titleLocked',
      'agentColor',
      'observedModel',
      'observedEffort',
      'transcriptAvailable',
    ]) {
      expect(SessionAggregate.shape).not.toHaveProperty(key)
    }
  })

  it('excludes the session’s derived twins (ADR 4 D3.6, inventory D-5)', () => {
    for (const key of ['displayRef', 'resumable', 'unread', 'machineName']) {
      expect(SessionAggregate.shape).not.toHaveProperty(key)
    }
    // …while keeping the inputs they are derived FROM, so the exclusion is a
    // relocation and not a loss.
    expect(SessionAggregate.shape).toHaveProperty('refLetter')
    expect(SessionAggregate.shape).toHaveProperty('resume')
  })

  it('excludes the issue’s derived rollups, which are also existence leaks', () => {
    for (const key of ['ready', 'blocked', 'deferred', 'childCount', 'commentCount']) {
      expect(IssueAggregate.shape).not.toHaveProperty(key)
    }
  })

  it('excludes IssueWire.sessions — THE entity-in-entity embed (ADR 4 D7.1)', () => {
    expect(IssueAggregate.shape).not.toHaveProperty('sessions')
    expect(IssueAggregate.shape).not.toHaveProperty('sessionSummary')
  })
})

/**
 * `SESSION_IMMUTABLE_AFTER_CREATE` — the SEMANTIC half its `satisfies` clause
 * cannot check.
 *
 * The `satisfies readonly (keyof SessionAggregate)[]` clause already binds the
 * constant to the aggregate at COMPILE time: POD-366 mutation-tested it
 * (`refDraft` → `refDraftTYPO` ⇒ TS2820, `packages/model` exits 1), so the
 * constant cannot silently go stale while it waits for its consumer.
 *
 * What that clause does NOT check is that the list means anything. A constant
 * naming EVERY key of the aggregate would satisfy the type and be nonsense —
 * "nothing about a session may ever change" is not a claim anyone intends. These
 * two assertions are the semantic half, so the constant is judged as an enforced
 * invariant awaiting its consumer rather than as an unused export.
 */
describe('SESSION_IMMUTABLE_AFTER_CREATE is a meaningful subset', () => {
  it('names only keys that exist on the aggregate — at RUNTIME, not just in the type', () => {
    const notKeys = SESSION_IMMUTABLE_AFTER_CREATE.filter((k) => !(k in SessionAggregate.shape))
    expect(notKeys).toEqual([])
  })

  it('leaves a NON-EMPTY mutable complement — it is a subset, not the whole aggregate', () => {
    // The assertion the `satisfies` clause cannot make. Without it, a list of
    // every key typechecks and asserts that a session is frozen at birth.
    const mutable = Object.keys(SessionAggregate.shape).filter(
      (k) => !(SESSION_IMMUTABLE_AFTER_CREATE as readonly string[]).includes(k),
    )

    expect(mutable.length).toBeGreaterThan(0)
    // Named members of the complement, so the test fails if the constant grows
    // to swallow fields the product changes on every write. `status` and
    // `lastActiveAt` are the two most obviously mutable things a session has.
    expect(mutable).toContain('status')
    expect(mutable).toContain('lastActiveAt')
  })

  it('holds the fields whose mutability would be a correctness bug', () => {
    // The judgement the constant exists to preserve (POD-366: "four lines of
    // JUDGEMENT, not four lines of code"). `spawnedBy` and `createdBy` quietly
    // becoming mutable is the failure nobody notices because nothing fails.
    for (const key of ['sessionId', 'createdAt', 'spawnedBy', 'createdBy', 'origin']) {
      expect(SESSION_IMMUTABLE_AFTER_CREATE).toContain(key)
    }
  })
})

describe('the two D-2 renames actually happened', () => {
  it('renames the issue’s blockedBy to blockedByNotes — it is prose, not edges', () => {
    // Both spellings are checked, so this cannot pass by the key being absent
    // for some unrelated reason.
    expect(IssueAggregate.shape).toHaveProperty('blockedByNotes')
    expect(IssueAggregate.shape).not.toHaveProperty('blockedBy')
  })

  it('renames issue origin/draft, and leaves the SESSION spellings alone', () => {
    expect(IssueAggregate.shape).toHaveProperty('intentOrigin')
    expect(IssueAggregate.shape).toHaveProperty('isDraftVessel')
    expect(IssueAggregate.shape).not.toHaveProperty('origin')
    expect(IssueAggregate.shape).not.toHaveProperty('draft')

    // The counterfactual: the session keeps `origin`, which is the whole reason
    // the issue had to move — one name, two facts.
    expect(SessionAggregate.shape).toHaveProperty('origin')
  })
})
