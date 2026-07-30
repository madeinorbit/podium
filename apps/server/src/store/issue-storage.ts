/**
 * `toStorage` / `fromStorage` — the ONE documented R1 ↔ R3 pair for issues
 * (ADR 4 §4.1, inventory §3 #2, POD-1151).
 *
 * ---------------------------------------------------------------------------
 * WHY A MAPPER AND NOT A DERIVATION
 * ---------------------------------------------------------------------------
 *
 * `IssueRow` (`./types.ts`) is the R3 encoding of the `issues` table. POD-1141
 * measured, and recorded at that definition site, that it cannot be a `Pick` or
 * a mapped type of `IssueAggregate`: the divergence is not a uniform transform
 * (enums vs stored text, raw JSON vs objects, three renames, historical
 * optionality). A per-key transform table encoding all of that would be a
 * restatement in a worse form, and — because a mapped type is checked
 * STRUCTURALLY — it could not notice two type-identical members being DIFFERENT
 * FACTS. `origin` and `audience` are both `'human' | 'agent'`; swapping them is
 * byte-identical on the wire and no golden fixture can see it.
 *
 * A MAPPER IS CHECKED PER KEY. That is the property this file buys, and
 * `issue-storage.test.ts` is what makes the claim testable rather than asserted.
 *
 * ---------------------------------------------------------------------------
 * THE PAIR IS NOT A BIJECTION TODAY, AND THAT IS A MEASURED STORAGE GAP
 * ---------------------------------------------------------------------------
 *
 * `IssueAggregate` is the canonical R1 issue. Storage cannot carry all of it, and
 * R1 deliberately excludes some of what storage carries. Rather than inventing
 * values at the seam (which would put the multi-user model's defaults in a
 * mapper, where nobody would find them), the gap is NAMED here, in one place, as
 * {@link ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY} and `toStorage`'s second argument —
 * so the list is the handoff to the issues that own the columns, and a test pins
 * it rather than a comment claiming it.
 *
 *   **R1 members with no column** (`ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY`):
 *   - `owner`, `visibility` — ADR 9 D2/D3. `docs/multi-user-readiness.md` is
 *     explicit that adding them is "a later table migration plus a wire change
 *     plus a replica migration"; POD-1075 owns the principal module.
 *   - `createdBy`, `lastLifecycleActor` — ADR 9 D5 A3's attribution pair. The
 *     row carries `startedBySession` (an ACTOR-half session id, dangling-
 *     tolerant) and nothing for the on-behalf-of half. ADR 9 D8 S5 forbids
 *     defaulting `onBehalfOf` to the operator or to the row's owner, so this
 *     mapper does not.
 *   - `labels` — stored in the `issue_labels` join table, read by
 *     `IssueStore.getIssueLabels`. Absent here is CORRECT: this pair maps one
 *     row, and giving it a labels member would make it look like a column.
 *   - the `attribution` half of `NeedsHuman.asked` — same reason as `createdBy`.
 *     `asked` itself IS composed, with that one member omitted; see
 *     {@link StoredAsked}.
 *
 *   **R3 columns R1 deliberately excludes** (`toStorage`'s second argument):
 *   - `readAt`, `tuckedAt`, `pinned` — per-user state. POD-1076 moves them to
 *     `(userId, issueId)` rows and `aggregates/registry.test.ts` FAILS if one
 *     reappears on the aggregate, so they cannot simply be added back.
 *   - `repoPath` — derived from the repo registry (inventory D-1: four stored
 *     spellings of one repo-relative fact). It lives on `IssueDerived`, not R1.
 *
 * The consequence for callers, stated plainly: this pair is enough to decode a
 * row for PROJECTION and to encode a freshly-built issue for INSERT. It is NOT
 * enough to make `IssueAggregate` the service's in-memory type — that needs
 * POD-1075 (attribution/ownership columns) and POD-1076 (per-user rows) first.
 *
 * ---------------------------------------------------------------------------
 * DECODER, NOT VALIDATION GATE
 * ---------------------------------------------------------------------------
 *
 * `fromStorage` reads a row this instance wrote. It must not throw and must not
 * silently drop a value it does not recognise, because a too-strict decoder on a
 * PERSISTED format makes yesterday's data unreadable (unlike a too-strict test,
 * which only fails a build). So `stage` and `type` are CAST rather than parsed —
 * exactly as `toWire` cast them before this file existed, and the DDL's CHECK
 * constraints are what actually constrain them. `color` keeps its existing
 * tolerant guard and `panel` its existing tolerant parse. Quarantining a
 * genuinely corrupt row is `IssueStore.listIssueRows`' job (it already skips,
 * logs and counts), not this mapper's.
 *
 * THE ONE KEY THAT DOES NOT ROUND-TRIP BY BYTES IS `panel`. It decodes through
 * `IssuePanel.parse` (tolerantly, to an empty panel) and encodes through
 * `JSON.stringify`, so an unparseable stored panel would come back as an empty
 * one. That is why `toStorage` is deliberately NOT wired into any
 * read-modify-write path: `create()` builds a fresh issue and encodes it once.
 * `IssueService` still patches rows as rows.
 */

import {
  IssueAggregate,
  IssuePanel,
  type IssueStage,
  type IssueType,
  isIssueColorSlot,
  NeedsHuman,
} from '@podium/model'
import type { IssueId, RepoId, SessionId, UserId } from '@podium/model'
import { z } from 'zod'
import type { IssueRow } from './types'

// ---------------------------------------------------------------------------
// The R1 side, composed from the aggregate — never restated
// ---------------------------------------------------------------------------

/**
 * The R1 members `issues` has no column for. Exported as DATA so the omission is
 * enumerable by a test and greppable by whoever adds the columns, instead of
 * being a comment that drifts from the `.omit()` below.
 */
export const ISSUE_R1_MEMBERS_STORAGE_CANNOT_CARRY = [
  'owner',
  'visibility',
  'createdBy',
  'lastLifecycleActor',
  'labels',
] as const

/**
 * `NeedsHuman.asked` minus the one member storage cannot carry.
 *
 * Derived from the group rather than rewritten, so every retained member is the
 * SHARED SCHEMA INSTANCE and a rename in `fields/issue.ts` reaches here. POD-365
 * made `asked` all-or-nothing on purpose — a shape where "when" is present and
 * "who" is absent must not typecheck — and that property survives the omission:
 * `question`, `at` and `by` stay required together.
 */
export const StoredAsked = NeedsHuman.shape.asked.unwrap().omit({ attribution: true })
export type StoredAsked = z.infer<typeof StoredAsked>

/**
 * A needs-human question that predates the `asked` invariant.
 *
 * `human_question_asked_by` / `_asked_at` arrived with issue #53; a row written
 * before that can hold a question with no asker. Such a row is NOT representable
 * as {@link StoredAsked}, and dropping it here would silently delete an open
 * question from the wire. So it decodes to its own member instead — named for
 * what it is, so the backfill list is visible rather than inferred. Its members
 * are `.optional()` precisely where {@link StoredAsked}'s are required: this
 * shape exists to hold the combinations that one refuses.
 */
export const LegacyAsked = z.object({
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  at: z.string().optional(),
  by: z.string().optional(),
})
export type LegacyAsked = z.infer<typeof LegacyAsked>



/**
 * THE IN-MEMORY ISSUE AS STORAGE CAN CARRY IT — the canonical aggregate minus
 * what no column exists for. The R3-only members are NOT here; `toStorage` takes
 * them as its second argument, as a `Pick` of the row.
 *
 * A COMPOSITION of `IssueAggregate`, not an eighteenth issue shape: every
 * retained key's schema is the same INSTANCE the thirteen field groups define,
 * which is the property `issue-storage.test.ts` asserts with `toBe`. A re-typed
 * `z.string()` in its place would be byte-identical and would pass every golden
 * fixture — ADR 4's drift in the exact form the wire gate cannot see.
 */
export const StoredIssue = IssueAggregate.omit({
  // The five members with no column, spelled from the exported constant's own
  // members so the list and the omission cannot drift apart.
  owner: true,
  visibility: true,
  createdBy: true,
  lastLifecycleActor: true,
  labels: true,
  // Re-added below, minus its `attribution` half.
  asked: true,
})
  .extend({
    asked: StoredAsked.optional(),
    /** Present only for a pre-#53 row — see {@link LegacyAsked}. Mutually
     *  exclusive with `asked` by construction of {@link fromStorage}. */
    askedLegacy: LegacyAsked.optional(),
  })
export type StoredIssue = z.infer<typeof StoredIssue>

// ---------------------------------------------------------------------------
// R3 -> R1
// ---------------------------------------------------------------------------

/**
 * Decode one stored row into the in-memory issue.
 *
 * Every key is written out BY HAND and on purpose. Two of these members are
 * type-identical to another (`intentOrigin` / `audience`, both `'human' |
 * 'agent'`) and three are renames of the column beside them; a structural
 * derivation would map either pair to the other without a single test noticing.
 */
export function fromStorage(row: IssueRow): StoredIssue {
  const asked = decodeAsked(row)
  return {
    // --- IssueIdentity ---------------------------------------------------
    // No cast: `IssueRow` carries branded ids (POD-362). The brand is applied
    // once, at the sqlite decode in `store/issues.ts#mapIssueRow`.
    id: row.id,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    seq: row.seq,

    // --- IssueText -------------------------------------------------------
    title: row.title,
    ...opt('brief', row.brief),
    ...opt('design', row.design),
    ...opt('acceptance', row.acceptance),
    ...opt('activityNotes', row.activityNotes),
    ...opt('notesUpdatedAt', row.notesUpdatedAt),
    ...opt('dependencyNote', row.dependencyNote),
    ...opt('suggestedReason', row.suggestedReason),

    // --- IssueDocuments (ADR 1 Am1 D12: materialized value, room beside) ---
    description: { value: row.description },
    ...(row.notes != null ? { notes: { value: row.notes } } : {}),

    // --- IssueLifecycle --------------------------------------------------
    // Cast, not parsed: see the file header's decoder-not-gate note.
    stage: row.stage as IssueStage,
    ...(row.suggestedStage ? { suggestedStage: row.suggestedStage as IssueStage } : {}),
    ...opt('closedReason', row.closedReason),
    ...opt('closedAt', row.closedAt),
    ...opt('deferUntil', row.deferUntil),
    archived: row.archived,
    ...opt('deletedAt', row.deletedAt),

    // --- IssueTriage (labels live in issue_labels, not on the row) --------
    priority: row.priority,
    type: row.type as IssueType,
    ...(row.assignee ? { assignee: row.assignee } : {}),
    ...(row.estimateMin != null ? { estimateMin: row.estimateMin } : {}),
    // Guarded so a corrupt/unknown stored slot degrades to "no colour" rather
    // than failing the issue [spec:SP-b4d1] — the behaviour `toWire` had.
    ...(isIssueColorSlot(row.color) ? { color: row.color } : {}),
    ...opt('sortKey', row.sortKey),
    ...opt('dueAt', row.dueAt),

    // --- IssueGraphRefs (RENAME: blockedBy -> blockedByNotes, D-2) --------
    ...(row.parentId ? { parentId: row.parentId } : {}),
    ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
    ...(row.duplicateOf ? { duplicateOf: row.duplicateOf } : {}),
    blockedByNotes: row.blockedBy,

    // --- IssueWorkspace (nullable, NOT optional — the row's own shape) ----
    worktreePath: row.worktreePath,
    branch: row.branch,
    parentBranch: row.parentBranch,
    ...(row.machineId ? { machineId: row.machineId } : {}),

    // --- IssueAgentDefaults ----------------------------------------------
    defaultAgent: row.defaultAgent,
    defaultModel: row.defaultModel,
    defaultEffort: row.defaultEffort,

    // --- NeedsHuman ------------------------------------------------------
    needsHuman: row.needsHuman,
    ...asked,

    // --- IssuePanelGroup (raw JSON column -> object) ----------------------
    ...(row.panel ? { panel: decodePanel(row.panel) } : {}),

    // --- IssueIntent (RENAMES: origin -> intentOrigin, draft -> isDraftVessel)
    // Read as an enum with 'human' as the closed default, which is what `toWire`
    // did inline: an unrecognised stored value is 'human', never passed through.
    intentOrigin: row.origin === 'agent' ? 'agent' : 'human',
    audience: row.audience === 'agent' ? 'agent' : 'human',
    isDraftVessel: row.draft ?? false,

    // --- IssueCoordination -----------------------------------------------
    ...(row.coordinatorSessionId
      ? { coordinatorSessionId: row.coordinatorSessionId }
      : {}),
    ...(row.startedBySession ? { startedBySession: row.startedBySession } : {}),

    // --- IssueLinear ------------------------------------------------------
    ...opt('linearId', row.linearId),
    ...opt('linearIdentifier', row.linearIdentifier),
    ...opt('linearUrl', row.linearUrl),
    ...opt('prUrl', row.prUrl),

    // --- timestamps -------------------------------------------------------
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// R1 -> R3
// ---------------------------------------------------------------------------

/**
 * Encode the in-memory issue back into a stored row.
 *
 * The inverse of {@link fromStorage} key by key, including the three renames and
 * the two type-identical enums. `panel` is the one member that round-trips by
 * VALUE rather than by bytes (see the file header).
 */
export function toStorage(
  issue: StoredIssue,
  /**
   * The R3-ONLY columns, spelled as a `Pick` of the row and deliberately NOT
   * given a name of their own.
   *
   * `readAt`, `tuckedAt` and `pinned` are per-user state (POD-1076's to re-key
   * onto `(userId, issueId)` rows) and `repoPath` is derived from the repo
   * registry (inventory D-1). Neither belongs on R1 — the aggregate's
   * `registry.test.ts` fails if one reappears there.
   *
   * Naming this shape was the first design here and it was WRONG, caught by
   * `scripts/rearch-audit.ts`: `per-user-singletons` is a RATCHET with no
   * registry escape, and a second declaration spelling those three keys grows
   * POD-1076's debt while claiming to collapse POD-302's. A `Pick` in argument
   * position keeps `IssueRow` as their ONE declaration.
   */
  storage: Pick<IssueRow, 'repoPath' | 'readAt' | 'tuckedAt' | 'pinned'>,
): IssueRow {
  const asked = issue.asked ?? issue.askedLegacy
  return {
    // --- IssueIdentity ---------------------------------------------------
    id: issue.id,
    repoPath: storage.repoPath,
    repoId: issue.repoId ?? null,
    seq: issue.seq,

    // --- IssueText -------------------------------------------------------
    title: issue.title,
    brief: issue.brief ?? null,
    design: issue.design ?? null,
    acceptance: issue.acceptance ?? null,
    activityNotes: issue.activityNotes ?? null,
    notesUpdatedAt: issue.notesUpdatedAt ?? null,
    dependencyNote: issue.dependencyNote ?? null,
    suggestedReason: issue.suggestedReason ?? null,

    // --- IssueDocuments ---------------------------------------------------
    description: issue.description.value,
    notes: issue.notes?.value ?? null,

    // --- IssueLifecycle ---------------------------------------------------
    stage: issue.stage,
    suggestedStage: issue.suggestedStage ?? null,
    closedReason: issue.closedReason ?? null,
    closedAt: issue.closedAt ?? null,
    deferUntil: issue.deferUntil ?? null,
    archived: issue.archived,
    deletedAt: issue.deletedAt ?? null,

    // --- IssueTriage -------------------------------------------------------
    priority: issue.priority,
    type: issue.type,
    assignee: issue.assignee ?? null,
    estimateMin: issue.estimateMin ?? null,
    color: issue.color ?? null,
    sortKey: issue.sortKey ?? null,
    dueAt: issue.dueAt ?? null,

    // --- IssueGraphRefs (RENAME back: blockedByNotes -> blockedBy) ---------
    parentId: issue.parentId ?? null,
    supersededBy: issue.supersededBy ?? null,
    duplicateOf: issue.duplicateOf ?? null,
    blockedBy: issue.blockedByNotes,

    // --- IssueWorkspace ----------------------------------------------------
    worktreePath: issue.worktreePath,
    branch: issue.branch,
    parentBranch: issue.parentBranch,
    machineId: issue.machineId ?? null,

    // --- IssueAgentDefaults ------------------------------------------------
    defaultAgent: issue.defaultAgent,
    defaultModel: issue.defaultModel,
    defaultEffort: issue.defaultEffort,

    // --- NeedsHuman --------------------------------------------------------
    needsHuman: issue.needsHuman,
    humanQuestion: asked?.question ?? null,
    humanQuestionOptions: asked?.options ?? null,
    humanQuestionAskedBy: asked?.by ?? null,
    humanQuestionAskedAt: asked?.at ?? null,

    // --- IssuePanelGroup (object -> raw JSON column) -----------------------
    panel: issue.panel ? JSON.stringify(issue.panel) : null,

    // --- IssueIntent (RENAMES back) ----------------------------------------
    origin: issue.intentOrigin,
    audience: issue.audience,
    draft: issue.isDraftVessel,

    // --- IssueCoordination --------------------------------------------------
    coordinatorSessionId: issue.coordinatorSessionId ?? null,
    startedBySession: issue.startedBySession ?? null,

    // --- IssueLinear --------------------------------------------------------
    linearId: issue.linearId ?? null,
    linearIdentifier: issue.linearIdentifier ?? null,
    linearUrl: issue.linearUrl ?? null,
    prUrl: issue.prUrl ?? null,

    // --- timestamps ---------------------------------------------------------
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,

    // --- R3's own, passed through untouched ---------------------------------
    readAt: storage.readAt ?? null,
    tuckedAt: storage.tuckedAt ?? null,
    pinned: storage.pinned,
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Present-or-absent for the row's `T | null | undefined` columns against R1's
 *  `.optional()` members. A HELPER WHOSE RETURN TYPE IS THE NARROW TYPE, because
 *  an optional key written inline beside a conditional spread is the one class a
 *  producer annotation does not excess-check (POD-1138). */
function opt<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value == null ? {} : { [key]: value }) as { [P in K]?: V }
}

/** Decode the needs-human quartet into whichever of the two shapes it satisfies.
 *  Returns `{}` when there is no question at all. */
function decodeAsked(row: IssueRow): { asked?: StoredAsked } | { askedLegacy?: LegacyAsked } {
  const options = row.humanQuestionOptions ?? undefined
  if (row.humanQuestion && row.humanQuestionAskedAt && row.humanQuestionAskedBy) {
    return {
      asked: {
        question: row.humanQuestion,
        ...(options ? { options } : {}),
        at: row.humanQuestionAskedAt,
        by: row.humanQuestionAskedBy,
      },
    }
  }
  const legacy: LegacyAsked = {
    ...opt('question', row.humanQuestion),
    ...(options ? { options } : {}),
    ...opt('at', row.humanQuestionAskedAt),
    ...opt('by', row.humanQuestionAskedBy),
  }
  // Only the empty quartet decodes to nothing. ANY populated column travels —
  // decoding is not the place to decide a partially-written question is junk,
  // and dropping one here would delete it from the wire on the next write.
  return Object.keys(legacy).length ? { askedLegacy: legacy } : {}
}

/** Parse the stored panel JSON, tolerating legacy/garbage values (empty panel).
 *  Moved here from `IssueService.parsePanel`: the raw-JSON-column split is an
 *  R1 ↔ R3 encoding and ADR 4 §4.1 puts it in this pair, not in a projection.
 *  Exported because three `crud.ts` sites decode the panel of a row they are
 *  about to patch as a row — one definition, two entry points. */
export function decodePanel(raw: string | null | undefined): IssuePanel {
  if (!raw) return { todos: [], artifacts: [], deferred: [] }
  try {
    return IssuePanel.parse(JSON.parse(raw))
  } catch {
    return { todos: [], artifacts: [], deferred: [] }
  }
}
