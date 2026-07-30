import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { asMatrixRowId } from '../annotations/ownership'
import { ROW } from '../annotations/matrix'
import { Attribution } from '../fields/attribution'
import { Ownership } from '../fields/ownership'
import { IssueAggregate } from './issue'
import { SessionAggregate } from './session'
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

  it('classifies both canonical aggregates as personal, not substrate', () => {
    // Both alternatives exist in the vocabulary the check reads, so this is not
    // vacuous: the previous test shows `deployment-substrate` is reachable and
    // rejected for these rows.
    expect(aggregateVisibilityOf('Session')).toBe('personal')
    expect(aggregateVisibilityOf('Issue')).toBe('personal')
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
  it.each(CANONICAL_AGGREGATES)('$name composes the Ownership group', ({ schema }) => {
    for (const key of Object.keys(Ownership.shape)) {
      expect(schema.shape).toHaveProperty(key)
    }
  })

  it.each(CANONICAL_AGGREGATES)('$name carries the attribution PAIR, unsplit', ({ schema }) => {
    const createdBy = (schema.shape as Record<string, unknown>).createdBy
    expect(createdBy).toBeDefined()

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
  'prUrl', 'priority', 'repoId', 'seq', 'sortKey', 'stage', 'startedBySession',
  'suggestedReason', 'suggestedStage', 'supersededBy', 'title', 'type', 'updatedAt',
  'visibility', 'worktreePath',
]

describe('the canonical key sets are pinned exactly', () => {
  it('SessionAggregate carries exactly these 43 keys and no others', () => {
    expect(Object.keys(SessionAggregate.shape).sort()).toEqual(SESSION_AGGREGATE_KEYS)
  })

  it('IssueAggregate carries exactly these 57 keys and no others', () => {
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
