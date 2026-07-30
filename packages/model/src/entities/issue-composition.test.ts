/**
 * `IssueWire` IS COMPOSED FROM THE SHARED FIELD GROUPS — POD-1141.
 *
 * WHY THE GOLDEN CORPUS CANNOT BE THIS TEST. Branding and schema identity are
 * COMPILE-TIME and reference-level facts; the encoded bytes are not. Swapping
 * `IssueText.shape.title` back for a fresh `z.string()` is byte-identical, passes
 * all 39550 golden cases, typechecks, and silently reintroduces exactly the
 * duplication this epic exists to delete. The only instrument that can see it is
 * an identity assertion — `toBe`, never `toEqual`, because `toEqual` on two
 * structurally equal zod schemas is true by construction.
 *
 * So: every substituted key is asserted BY HAND against the group member it must
 * be, and the membership list is pinned so the suite cannot quietly shrink.
 */

import { describe, expect, it } from 'vitest'
import { IssueWire } from './issue'
import { IssueGitState } from './issue-vocabulary'
import {
  IssueAgentDefaults,
  IssueCoordination,
  IssueDerived,
  IssueDocuments,
  IssueGraphRefs,
  IssueIdentity,
  IssueIntent,
  IssueLifecycle,
  IssueLinear,
  IssuePanelGroup,
  IssueText,
  IssueTriage,
  IssueWorkspace,
  NeedsHuman,
} from '../fields/issue'

const wire = IssueWire.shape as Record<string, unknown>

/** Every issue field group, so the uncomposed-key scan cannot miss one. */
const ALL_GROUPS = [
  IssueAgentDefaults,
  IssueCoordination,
  IssueDerived,
  IssueDocuments,
  IssueGraphRefs,
  IssueIdentity,
  IssueIntent,
  IssueLifecycle,
  IssueLinear,
  IssuePanelGroup,
  IssueText,
  IssueTriage,
  IssueWorkspace,
  NeedsHuman,
] as const

/**
 * THE 43 COMPOSED KEYS, hand-adjudicated one at a time.
 *
 * Type identity is what makes a substitution BYTE-SAFE; it is never what makes it
 * CORRECT. Two fields can encode identically and be different facts — see the
 * `updatedAt` / `branch` cases pinned at the bottom of this file. Every entry
 * here was checked to be the same FACT as the wire key it replaces, not merely
 * the same type.
 */
const COMPOSED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['id', IssueIdentity.shape],
  ['repoId', IssueIdentity.shape],
  ['seq', IssueIdentity.shape],
  ['prefix', IssueDerived.shape],
  ['displayRef', IssueDerived.shape],
  ['title', IssueText.shape],
  ['brief', IssueText.shape],
  ['design', IssueText.shape],
  ['acceptance', IssueText.shape],
  ['activityNotes', IssueText.shape],
  ['notesUpdatedAt', IssueText.shape],
  ['dependencyNote', IssueText.shape],
  ['suggestedReason', IssueText.shape],
  ['stage', IssueLifecycle.shape],
  ['suggestedStage', IssueLifecycle.shape],
  ['closedReason', IssueLifecycle.shape],
  ['closedAt', IssueLifecycle.shape],
  ['deferUntil', IssueLifecycle.shape],
  ['archived', IssueLifecycle.shape],
  ['deletedAt', IssueLifecycle.shape],
  ['priority', IssueTriage.shape],
  ['type', IssueTriage.shape],
  // POD-362 composed this; NOT_COMPOSED's note said "until the flip".
  ['assignee', IssueTriage.shape],
  ['labels', IssueTriage.shape],
  ['estimateMin', IssueTriage.shape],
  ['sortKey', IssueTriage.shape],
  ['dueAt', IssueTriage.shape],
  ['parentId', IssueGraphRefs.shape],
  ['supersededBy', IssueGraphRefs.shape],
  ['duplicateOf', IssueGraphRefs.shape],
  ['worktreePath', IssueWorkspace.shape],
  ['branch', IssueWorkspace.shape],
  ['parentBranch', IssueWorkspace.shape],
  ['machineId', IssueWorkspace.shape],
  ['defaultAgent', IssueAgentDefaults.shape],
  ['defaultModel', IssueAgentDefaults.shape],
  ['defaultEffort', IssueAgentDefaults.shape],
  ['linearId', IssueLinear.shape],
  ['linearIdentifier', IssueLinear.shape],
  ['linearUrl', IssueLinear.shape],
  ['prUrl', IssueLinear.shape],
  ['needsHuman', NeedsHuman.shape],
  ['panel', IssuePanelGroup.shape],
  ['coordinatorSessionId', IssueCoordination.shape],
] as const

/**
 * THE KEYS DELIBERATELY NOT COMPOSED, each with the class it belongs to. Pinned
 * as a SET so that "composed 43" cannot become "composed 43" while a key quietly
 * moves between the two lists — 43 + 35 must still be the whole wire.
 */
const NOT_COMPOSED: Readonly<Record<string, string>> = {
  // Renames POD-365 deliberately kept OFF the wire (D-2).
  blockedBy: 'renamed to blockedByNotes on composition; wire keeps the old name',
  origin: 'renamed to intentOrigin on composition',
  draft: 'renamed to isDraftVessel on composition',
  // The IssueDocuments wrapper: op-stream documents, plain strings on the wire.
  description: 'IssueDocuments wraps this as an OpStreamDocument',
  notes: 'IssueDocuments wraps this as an OpStreamDocument',
  // The flattened needs-human tuple — one nested `asked` object on the group.
  humanQuestion: 'flattened from NeedsHuman.asked',
  humanQuestionOptions: 'flattened from NeedsHuman.asked',
  humanQuestionAskedBy: 'flattened from NeedsHuman.asked',
  humanQuestionAskedAt: 'flattened from NeedsHuman.asked',
  // Per-user state, absent from the groups BY CONSTRUCTION (POD-1076 re-keys it).
  tuckedAt: 'per-user state',
  pinned: 'per-user state; also a second pin mechanism POD-1076 collapses',
  readAt: 'per-user state',
  // Derived rollups whose OPTIONALITY differs from the group.
  repoPath: 'derived; optional on IssueDerived, required on the wire',
  commentCount: 'derived rollup; optionality differs',
  ready: 'derived rollup; optionality differs',
  blocked: 'derived rollup; optionality differs',
  deferred: 'derived rollup; optionality differs',
  childCount: 'derived rollup; optionality differs',
  childDoneCount: 'derived rollup; optionality differs',
  unread: 'derived rollup; optionality differs',
  sessionSummary: 'derived rollup; optionality differs',
  gitState: 'derived rollup; optionality differs',
  // Wire tolerance (`.catch`) the group does not carry.
  color: 'wire adds .catch(undefined) tolerance',
  audience: 'wire adds .catch tolerance',
  // The brand flip, owned by POD-362/POD-363, not by this issue.
  startedBySession: 'group brands it SessionId; wire is still z.string()',
  // Derived edges, the deprecated array, the embed, provenance, timestamps.
  deps: 'derived from issue_deps',
  dependents: 'derived from issue_deps',
  comments: 'DEPRECATED off the wire (#175)',
  sessions: "the entity-in-entity embed; POD-308's, not this issue's",
  viaHub: 'flat provenance encoding',
  upstreamStale: 'flat provenance encoding',
  pendingSync: 'flat provenance encoding',
  createdAt: 'no group member',
  updatedAt: 'entity mtime — see the different-facts test below',
} as const

describe('IssueWire composes the shared field groups', () => {
  it('accounts for every wire key exactly once', () => {
    // Rule: a parameterised suite whose parameter list IS the thing under test
    // cannot notice its own coverage shrinking. Pin the membership, not a count.
    const composed = COMPOSED.map(([k]) => k)
    expect(new Set(composed).size, 'a key listed twice as composed').toBe(composed.length)
    expect([...composed, ...Object.keys(NOT_COMPOSED)].sort()).toEqual(Object.keys(wire).sort())
    // 44 since POD-362 composed `assignee`, which this list previously excluded
    // with the note "wire is still z.string() until the flip". This was the flip.
    expect(composed).toHaveLength(44)
  })

  it.each(COMPOSED)('%s IS the shared group member, not a restatement', (key, groupShape) => {
    // `toBe`, not `toEqual`: a fresh `z.string()` is toEqual-equal to the shared
    // one and encodes identically. Only reference identity sees the drift.
    expect(groupShape[key], `IssueWire.${key} is not the shared definition`).toBeDefined()
    expect(wire[key]).toBe(groupShape[key])
  })

  it('leaves the uncomposed keys genuinely uncomposed', () => {
    // The counterfactual: prove the NOT_COMPOSED list is not merely unexamined.
    // Where a same-named group member EXISTS, the wire key must not be it.
    let checked = 0
    for (const key of Object.keys(NOT_COMPOSED)) {
      for (const group of ALL_GROUPS) {
        const shape = group.shape as Record<string, unknown>
        if (!(key in shape)) continue
        checked++
        expect(wire[key], `${key} is composed but listed as NOT_COMPOSED`).not.toBe(shape[key])
      }
    }
    // Verify the instrument: a loop that compared nothing would pass silently.
    // 15 of the uncomposed keys have a same-named member (16 before POD-362
    // composed `assignee`; the rest are keys
    // no group declares at all, e.g. `createdAt`, `deps`, `tuckedAt`).
    expect(checked, 'the uncomposed-key scan compared nothing').toBe(15)
  })
})

describe('type identity is not fact identity', () => {
  /**
   * The trap this issue was warned about, pinned so a later "same type, therefore
   * substitute" sweep cannot pass. Both pairs are type-identical and encode
   * identically; both are DIFFERENT FACTS, and no golden fixture could see a swap.
   */
  it('branch is the ISSUE\'s branch, never the checkout\'s', () => {
    expect(wire.branch).toBe(IssueWorkspace.shape.branch)
    // IssueGitState.branch is "the branch the checkout is ACTUALLY on" — a probe
    // result that may differ from the branch the issue owns.
    expect(wire.branch).not.toBe(IssueGitState.shape.branch)
  })

  it('updatedAt is the entity mtime, never the last-probe timestamp', () => {
    // IssueGitState.updatedAt is the ISO time of the last completed git probe.
    // It is `z.string()` and so is the wire's entity mtime. Never substitute it.
    expect(wire.updatedAt).not.toBe(IssueGitState.shape.updatedAt)
  })
})
