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
import { z } from 'zod'
import { IssueIdField } from '../ids'
import { IssueWire } from './issue'
import { IssueGitState } from './issue-vocabulary'
import {
  IssueAgentDefaults,
  IssueConcurrency,
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
  IssueConcurrency,
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
  ['revision', IssueConcurrency.shape],
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
 * COMPOSED UNDER A DIFFERENT NAME — the third category, added by POD-1144.
 *
 * `[wireKey, groupKey, groupShape]`. The two lists above are name-keyed because
 * the wire key and the vocabulary key normally agree; D-2's renames are the case
 * where they do not. `blockedBy` was parked in NOT_COMPOSED on that basis, and
 * the parking hid a defect: the wire field was `z.array(IssueIdField)` while the
 * group's `blockedByNotes` is `z.array(z.string())`, so "not composed" was
 * covering for two types that disagreed about whether the value is an id.
 *
 * Same NAME and same FACT are different questions. The fact is identical — this
 * is the assistant's prose, from `refreshAssistant`, in both places — so it must
 * be the same schema instance. The name still differs, and renaming the WIRE key
 * is a wire change (golden corpus + the v1 legacy adapter) that POD-1145 owns.
 * Until then the substitution is real and this list is where it is accounted for,
 * rather than in an exception list that would let the types drift apart again.
 */
const COMPOSED_RENAMED: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['blockedBy', 'blockedByNotes', IssueGraphRefs.shape],
]

/**
 * THE KEYS DELIBERATELY NOT COMPOSED, each with the class it belongs to. Pinned
 * as a SET so that "composed 43" cannot become "composed 43" while a key quietly
 * moves between the two lists — 43 + 35 must still be the whole wire.
 */
const NOT_COMPOSED: Readonly<Record<string, string>> = {
  // Renames POD-365 deliberately kept OFF the wire (D-2). `blockedBy` USED TO BE
  // HERE and is now in COMPOSED_RENAMED — POD-1144 composed it; see that list.
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
  gitState: 'derived rollup; optionality differs',
  // Wire tolerance (`.catch`) the group does not carry.
  color: 'wire adds .catch(undefined) tolerance',
  audience: 'wire adds .catch tolerance',
  // The brand flip, owned by POD-362/POD-363, not by this issue.
  startedBySession: 'group brands it SessionId; wire is still z.string()',
  // `unread`, `sessionSummary` and `sessions` USED TO BE LISTED HERE and are not
  // any more: POD-797 took all three off the wire (taken from main at the
  // POD-1246 catch-up), so there is no wire key left to except. They are removed
  // rather than kept with a "no longer on the wire" note, because this table's
  // whole contract is that it accounts for the wire's keys EXACTLY ONCE — an
  // entry for a key that does not exist would make the accounting pass while
  // being wrong in the other direction.
  //
  // Derived edges, the deprecated array, provenance, timestamps.
  deps: 'derived from issue_deps',
  dependents: 'derived from issue_deps',
  comments: 'DEPRECATED off the wire (#175)',
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
    const renamed = COMPOSED_RENAMED.map(([wireKey]) => wireKey)
    expect(new Set(composed).size, 'a key listed twice as composed').toBe(composed.length)
    expect([...composed, ...renamed, ...Object.keys(NOT_COMPOSED)].sort()).toEqual(
      Object.keys(wire).sort(),
    )
    // 44 since POD-362 composed `assignee`, which this list previously excluded
    // with the note "wire is still z.string() until the flip". This was the flip.
    // 45 since the POD-1246 catch-up composed `revision` — link 3 of ADR 2 D3's
    // expected-revision chain, recovered from main.
    expect(composed).toHaveLength(45)
  })

  it.each(COMPOSED)('%s IS the shared group member, not a restatement', (key, groupShape) => {
    // `toBe`, not `toEqual`: a fresh `z.string()` is toEqual-equal to the shared
    // one and encodes identically. Only reference identity sees the drift.
    expect(groupShape[key], `IssueWire.${key} is not the shared definition`).toBeDefined()
    expect(wire[key]).toBe(groupShape[key])
  })

  it.each(COMPOSED_RENAMED)(
    '%s IS the shared group member %s under another name',
    (wireKey, groupKey, groupShape) => {
      expect(groupShape[groupKey], `no group member named ${groupKey}`).toBeDefined()
      expect(wire[wireKey]).toBe(groupShape[groupKey])
    },
  )

  it('blockedBy is NOT branded — the id brand cannot be what guards it', () => {
    // WHY THIS TEST IS AN IDENTITY ASSERTION AND NOT A PARSE ASSERTION, which is
    // the whole reason POD-1144's defect survived review for two issues.
    //
    // `IssueId` is `z.string().min(1).brand<'IssueId'>()` — LENGTH-ONLY. So the
    // wrong schema, `z.array(IssueIdField)`, accepts 'issue/1144-…' at RUNTIME
    // just as happily as the right one. Every parse-based test passes under both,
    // every golden fixture is byte-identical under both, and the lie was visible
    // only to the type checker — which is exactly why the projection could reach
    // the wire through a cast and nothing went red.
    //
    // Pinned so a later sweep cannot re-brand this field and call it a tightening.
    expect(wire.blockedBy).not.toBe(IssueGraphRefs.shape.parentId)
    expect(z.array(IssueIdField).safeParse(['issue/1144-not-an-id']).success).toBe(true)
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
    // 13 of the uncomposed keys have a same-named member (16 before POD-362
    // composed `assignee`; 15 until POD-797 took `unread` and `sessionSummary`
    // off the wire — `sessions` was the third key removed but had no same-named
    // group member, so it never counted here. The rest are keys no group declares
    // at all, e.g. `createdAt`, `deps`, `tuckedAt`).
    expect(checked, 'the uncomposed-key scan compared nothing').toBe(13)
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
