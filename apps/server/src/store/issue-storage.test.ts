/**
 * The R1 ↔ R3 issue pair (POD-1151).
 *
 * Three claims are under test, and they need DIFFERENT instruments:
 *
 *  1. **The R1 side is composed, not restated.** Only schema-INSTANCE identity
 *     (`toBe`) can see this. A member retyped as a fresh `z.string()` is
 *     byte-identical on the wire and passes every golden fixture — that is
 *     exactly the drift this epic exists to close, and the wire gate is blind to
 *     it because branding is compile-time.
 *  2. **The mapping is per key.** A round trip over a fixture in which every
 *     type-identical pair holds DIFFERENT values. `origin`/`audience` are both
 *     `'human' | 'agent'`; a fixture with `'human'` in both cannot see them
 *     swapped, so the fixture below deliberately does not do that.
 *  3. **The gap is what the file says it is.** The omitted set is pinned by
 *     membership, not by count: a parameterised claim whose parameter list is the
 *     thing under test cannot notice its own coverage shrinking.
 */

import { IssueAgentDefaults, IssueCoordination, IssueGraphRefs, IssueIdentity, IssueIntent, IssueLifecycle, IssueLinear, IssuePanelGroup, IssueText, IssueTriage, IssueWorkspace, NeedsHuman, asIssueId, asRepoId, asSessionId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  fromStorage,
  ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY,
  StoredIssue,
  toStorage,
} from './issue-storage'
import type { IssueRow } from './types'

/**
 * A row with EVERY optional column populated and every same-typed pair holding a
 * DIFFERENT value — the counterfactual the swap mutant needs.
 *
 * Specifically: `origin: 'agent'` beside `audience: 'human'` (both
 * `'human' | 'agent'`), `linearId`/`linearIdentifier`/`linearUrl`/`prUrl` all
 * distinct strings, and the four date-ish columns all distinct.
 */
const fullRow = (): IssueRow => ({
  id: asIssueId('iss_1'),
  repoPath: '/repo',
  repoId: asRepoId('repo_a'),
  seq: 42,
  title: 'Fix login',
  description: 'the human summary',
  brief: 'the agent handoff',
  stage: 'in_progress',
  worktreePath: '/repo/.worktrees/x',
  branch: 'issue/42-x',
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'opus',
  defaultEffort: 'high',
  machineId: 'machine-1',
  linearId: 'lin-id',
  linearIdentifier: 'LIN-1',
  linearUrl: 'https://linear.app/LIN-1',
  activityNotes: 'activity',
  notesUpdatedAt: '2026-01-05T00:00:00Z',
  suggestedStage: 'review',
  suggestedReason: 'because',
  blockedBy: ['some-branch', 'another note'],
  dependencyNote: 'dep note',
  prUrl: 'https://github.com/x/y/pull/1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  archived: true,
  deletedAt: '2026-01-09T00:00:00Z',
  priority: 1,
  type: 'bug',
  assignee: asUserId('mgw'),
  parentId: asIssueId('iss_parent'),
  design: 'design doc',
  acceptance: 'acceptance text',
  notes: 'the notes document',
  dueAt: '2026-02-01T00:00:00Z',
  deferUntil: '2026-01-20T00:00:00Z',
  closedReason: 'fixed',
  closedAt: '2026-01-08T00:00:00Z',
  supersededBy: asIssueId('iss_super'),
  duplicateOf: asIssueId('iss_dupe'),
  sortKey: 'a0',
  color: 'rose',
  estimateMin: 90,
  needsHuman: true,
  humanQuestion: 'which branch?',
  humanQuestionOptions: ['main', 'develop'],
  humanQuestionAskedBy: asSessionId('sess_1'),
  humanQuestionAskedAt: '2026-01-03T00:00:00Z',
  panel: JSON.stringify({ todos: [], artifacts: [], deferred: [] }),
  // The two type-identical enums, deliberately DIFFERENT.
  origin: 'agent',
  audience: 'human',
  draft: true,
  coordinatorSessionId: asSessionId('sess_coord'),
  startedBySession: asSessionId('sess_start'),
})

/** The same row with every nullable column at its empty value. */
const emptyRow = (): IssueRow => ({
  id: asIssueId('iss_2'),
  repoPath: '/repo',
  repoId: null,
  seq: 1,
  title: 'bare',
  description: '',
  brief: null,
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: null,
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [],
  dependencyNote: null,
  prUrl: null,
  createdAt: 't0',
  updatedAt: 't0',
  archived: false,
  deletedAt: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  design: null,
  acceptance: null,
  notes: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  sortKey: null,
  color: null,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  humanQuestionOptions: null,
  humanQuestionAskedBy: null,
  humanQuestionAskedAt: null,
  panel: null,
  origin: 'human',
  audience: 'human',
  draft: false,
  coordinatorSessionId: null,
  startedBySession: null,
})

/** The ONE R3-only column, lifted off the row so a round trip can hand it back.
 *  It was a quartet until POD-1076 re-keyed the other three onto per-user rows —
 *  they are not columns of this row for any user, so they cannot be passed here. */
const storageOnly = (row: IssueRow): Parameters<typeof toStorage>[1] => ({
  repoPath: row.repoPath,
})

/** Decode then re-encode one row — the identity the pair must preserve. */
const roundTrip = (row: IssueRow): IssueRow => toStorage(fromStorage(row), storageOnly(row))

describe('StoredIssue members ARE the shared field-group instances', () => {
  const cases: Array<[string, unknown]> = [
    ['id', IssueIdentity.shape.id],
    ['repoId', IssueIdentity.shape.repoId],
    ['seq', IssueIdentity.shape.seq],
    ['title', IssueText.shape.title],
    ['brief', IssueText.shape.brief],
    ['design', IssueText.shape.design],
    ['acceptance', IssueText.shape.acceptance],
    ['activityNotes', IssueText.shape.activityNotes],
    ['notesUpdatedAt', IssueText.shape.notesUpdatedAt],
    ['dependencyNote', IssueText.shape.dependencyNote],
    ['suggestedReason', IssueText.shape.suggestedReason],
    ['stage', IssueLifecycle.shape.stage],
    ['suggestedStage', IssueLifecycle.shape.suggestedStage],
    ['closedReason', IssueLifecycle.shape.closedReason],
    ['closedAt', IssueLifecycle.shape.closedAt],
    ['deferUntil', IssueLifecycle.shape.deferUntil],
    ['archived', IssueLifecycle.shape.archived],
    ['deletedAt', IssueLifecycle.shape.deletedAt],
    ['priority', IssueTriage.shape.priority],
    ['type', IssueTriage.shape.type],
    ['assignee', IssueTriage.shape.assignee],
    ['estimateMin', IssueTriage.shape.estimateMin],
    ['color', IssueTriage.shape.color],
    ['sortKey', IssueTriage.shape.sortKey],
    ['dueAt', IssueTriage.shape.dueAt],
    ['parentId', IssueGraphRefs.shape.parentId],
    ['supersededBy', IssueGraphRefs.shape.supersededBy],
    ['duplicateOf', IssueGraphRefs.shape.duplicateOf],
    ['blockedByNotes', IssueGraphRefs.shape.blockedByNotes],
    ['worktreePath', IssueWorkspace.shape.worktreePath],
    ['branch', IssueWorkspace.shape.branch],
    ['parentBranch', IssueWorkspace.shape.parentBranch],
    ['machineId', IssueWorkspace.shape.machineId],
    ['defaultAgent', IssueAgentDefaults.shape.defaultAgent],
    ['defaultModel', IssueAgentDefaults.shape.defaultModel],
    ['defaultEffort', IssueAgentDefaults.shape.defaultEffort],
    ['needsHuman', NeedsHuman.shape.needsHuman],
    ['panel', IssuePanelGroup.shape.panel],
    ['intentOrigin', IssueIntent.shape.intentOrigin],
    ['audience', IssueIntent.shape.audience],
    ['isDraftVessel', IssueIntent.shape.isDraftVessel],
    ['coordinatorSessionId', IssueCoordination.shape.coordinatorSessionId],
    ['startedBySession', IssueCoordination.shape.startedBySession],
    ['linearId', IssueLinear.shape.linearId],
    ['linearIdentifier', IssueLinear.shape.linearIdentifier],
    ['linearUrl', IssueLinear.shape.linearUrl],
    ['prUrl', IssueLinear.shape.prUrl],
  ]

  it.each(cases)('%s is the field group instance, not an equivalent copy', (key, expected) => {
    expect(StoredIssue.shape[key as keyof typeof StoredIssue.shape]).toBe(expected)
  })

  it('covers every composed member — the case list cannot silently shrink', () => {
    // Pin MEMBERSHIP, not a count: "46 passed" and "43 passed" read identically.
    const covered = new Set(cases.map(([k]) => k))
    const unchecked = Object.keys(StoredIssue.shape)
      .filter((k) => !covered.has(k) && !['asked', 'askedLegacy'].includes(k))
      .sort()
    // What is left has no field group to be an instance OF: the two op-stream
    // documents (asserted by shape below) and the aggregate's own two timestamps.
    expect(unchecked).toEqual(['createdAt', 'description', 'notes', 'updatedAt'])
  })

  it('description and notes carry the op-stream document shape, not a plain string', () => {
    // ADR 1 Am1 D12: the day the class is implemented must not be the day the
    // shape changes. A `z.string()` here would round-trip identically.
    expect(StoredIssue.shape.description.safeParse('plain string').success).toBe(false)
    expect(StoredIssue.shape.description.safeParse({ value: 'x' }).success).toBe(true)
  })
})

describe('the storage gap is named, not invented', () => {
  it('omits exactly the five R1 members storage has no column for', () => {
    for (const member of ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY) {
      expect(Object.keys(StoredIssue.shape)).not.toContain(member)
    }
    expect([...ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY]).toEqual([
      'owner',
      'visibility',
      'createdBy',
      'lastLifecycleActor',
      'labels',
    ])
  })

  it('asked keeps its all-or-nothing invariant with only attribution removed', () => {
    // The counterfactual: attribution IS gone (so the omission happened at all)…
    expect(Object.keys(StoredIssue.shape.asked.unwrap().shape)).toEqual([
      'question',
      'options',
      'at',
      'by',
    ])
    // …and "when without who" still does not parse, which is the property
    // POD-365 built the nested object for.
    expect(
      StoredIssue.shape.asked.unwrap().safeParse({ question: 'q', at: 't' }).success,
    ).toBe(false)
  })

  it('keeps the per-user and derived columns OFF R1', () => {
    // The audit's per-user-singletons item is a ratchet with no registry escape:
    // re-declaring these here would grow POD-1076's debt while claiming to
    // collapse POD-302's. `IssueStorageOnly` is a Pick of the row, so `IssueRow`
    // stays their ONE declaration.
    for (const k of ['readAt', 'tuckedAt', 'pinned', 'repoPath']) {
      expect(Object.keys(StoredIssue.shape)).not.toContain(k)
    }
  })
})

describe('fromStorage / toStorage round-trip per key', () => {
  it('restores a fully populated row byte for byte', () => {
    // toStrictEqual, not toEqual: an undefined-valued key reads as ABSENT to
    // toEqual, so it cannot see the key-presence class this pair is full of.
    expect(roundTrip(fullRow())).toStrictEqual(fullRow())
  })

  it('restores an all-empty row byte for byte', () => {
    expect(roundTrip(emptyRow())).toStrictEqual(emptyRow())
  })

  it('round-trips intentOrigin and audience to their OWN columns', () => {
    // The named target of the swap mutant. The fixture holds DIFFERENT values in
    // the two, which is the only reason this assertion can fail.
    const decoded = fromStorage(fullRow())
    expect(decoded.intentOrigin).toBe('agent')
    expect(decoded.audience).toBe('human')
    const back = toStorage(decoded, storageOnly(fullRow()))
    expect(back.origin).toBe('agent')
    expect(back.audience).toBe('human')
  })

  it('applies the three D-2 renames and no others', () => {
    const decoded = fromStorage(fullRow())
    expect(decoded.blockedByNotes).toEqual(['some-branch', 'another note'])
    expect(decoded.isDraftVessel).toBe(true)
    expect(decoded).not.toHaveProperty('blockedBy')
    expect(decoded).not.toHaveProperty('origin')
    expect(decoded).not.toHaveProperty('draft')
  })

  it('decodes the raw panel JSON column into an object', () => {
    const row = fullRow()
    row.panel = JSON.stringify({
      todos: [{ text: 'a', done: false }],
      artifacts: [],
      deferred: [],
    })
    const decoded = fromStorage(row)
    expect(decoded.panel?.todos).toHaveLength(1)
    expect(toStorage(decoded, storageOnly(row)).panel).toBe(row.panel)
  })

  it('degrades an unparseable panel to empty rather than throwing', () => {
    const row = fullRow()
    row.panel = 'not json at all'
    expect(fromStorage(row).panel).toEqual({ todos: [], artifacts: [], deferred: [] })
  })

  it('degrades an unknown colour slot to no colour rather than throwing', () => {
    const row = fullRow()
    row.color = 'chartreuse' as IssueRow['color']
    expect(fromStorage(row).color).toBeUndefined()
  })

  it('passes an unrecognised stage through instead of refusing the row', () => {
    // A decoder on a persisted format that refuses what it cannot classify makes
    // yesterday's data unreadable. The DDL CHECK is the constraint, not this.
    const row = fullRow()
    row.stage = 'some_future_stage'
    expect(fromStorage(row).stage).toBe('some_future_stage')
    expect(roundTrip(row).stage).toBe('some_future_stage')
  })
})

describe('the needs-human quartet', () => {
  it('decodes a complete question into the composed asked group', () => {
    const decoded = fromStorage(fullRow())
    expect(decoded.asked).toEqual({
      question: 'which branch?',
      options: ['main', 'develop'],
      at: '2026-01-03T00:00:00Z',
      by: 'sess_1',
    })
    expect(decoded.askedLegacy).toBeUndefined()
  })

  it('keeps a pre-#53 question that has no asker, under askedLegacy', () => {
    // The counterfactual for "dropped": the SAME row with an asker decodes to
    // `asked` (asserted above), so a failure here is the missing-asker case only.
    const row = fullRow()
    row.humanQuestionAskedBy = null
    row.humanQuestionAskedAt = null
    const decoded = fromStorage(row)
    expect(decoded.asked).toBeUndefined()
    expect(decoded.askedLegacy).toEqual({
      question: 'which branch?',
      options: ['main', 'develop'],
    })
    // And it survives the round trip rather than being deleted from the wire.
    expect(toStorage(decoded, storageOnly(row)).humanQuestion).toBe('which branch?')
  })

  it('emits neither shape when the whole quartet is empty', () => {
    const decoded = fromStorage(emptyRow())
    expect(decoded.asked).toBeUndefined()
    expect(decoded.askedLegacy).toBeUndefined()
  })

  it('carries an asker recorded WITHOUT a question rather than discarding it', () => {
    // The degenerate half-written quartet. It reaches the wire today, so a
    // decoder that silently dropped it would delete it on the next write.
    const row = emptyRow()
    row.humanQuestionAskedBy = asSessionId('sess_9')
    const decoded = fromStorage(row)
    expect(decoded.asked).toBeUndefined()
    expect(decoded.askedLegacy).toEqual({ by: 'sess_9' })
    expect(toStorage(decoded, storageOnly(row))).toStrictEqual(row)
  })
})
