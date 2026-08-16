/**
 * ONE SPELLING FOR ABSENT on the issue row [POD-820, ADR 4 D3].
 *
 * A nullable text column can hold both `null` and `''`, so the durable
 * vocabulary had two spellings for the same value. Nothing distinguishes them:
 * every consumer that reads `assignee`/`branch`/`prUrl` tests truthiness, and
 * both spellings render identically. Two encodings of one value with no reader
 * that can tell them apart is precisely the representation ambiguity ADR 4
 * exists to remove.
 *
 * It was invisible while the legacy serializer omitted on TRUTHINESS
 * (`...(row.assignee ? { assignee: row.assignee } : {})`, `service/core.ts`),
 * which collapsed `'' → absent → null` on every read. `@podium/model`'s mapping
 * pair omits on `=== null` instead (`dropNullValues`), so `''` round-trips
 * faithfully — correct, and the reason the ambiguity became VISIBLE rather than
 * being created. The fix is not to reintroduce the collapse on the read path but
 * to stop storing the second spelling at all.
 *
 * ## Why the WRITE path, and why here
 *
 * {@link IssuesCore.persistWith} is the single choke point every issue row write
 * passes through — `create()`, `update()`'s `Object.assign`, and each dedicated
 * mutator that funnels into them. Normalizing there means the invariant holds
 * for paths written after this one, including ones that never think about it. It
 * runs BEFORE the commit and mutates in place, which is the same contract
 * `persistWith`'s in-place rollback seam already relies on: a commit throw
 * restores the last-committed field state into the same object reference, so a
 * rolled-back write does not leave the normalization behind either.
 *
 * ## Why the column list is derived, not chosen
 *
 * POD-796 measured the live blast radius at 2 rows (`assignee`), so a per-column
 * patch would have been enough to close the observed divergence. It would also
 * have been the wrong shape: the ambiguity is a property of "nullable text
 * column", not of `assignee`, and the next nullable column added would silently
 * reopen it. {@link NullableTextColumn} names the whole class off `IssueRow`
 * itself, and {@link BLANK_TO_NULL_COLUMNS} is checked against it — a new
 * nullable text column that is not listed fails to compile.
 *
 * NON-nullable text columns are deliberately out of scope and MUST stay out.
 * `description` is the live case: 146 rows hold `''`, it is `string` (not
 * `string | null`), and `''` is its legitimate "no description" value — there is
 * no second spelling to collapse, and nulling it would be a schema violation.
 * The type does that reasoning for us rather than trusting the list.
 */
import type { IssueRow } from '../../store/types'

/**
 * Every `IssueRow` column whose type is `<text> | null`.
 *
 * `-?` strips optionality first so `brief?: string | null` is seen as
 * `string | null`. Branded ids (`UserId`, `IssueId`, `SessionId`) and literal
 * unions (`IssueColorSlot`) are text and are included — `''` is not a valid
 * member of any of them, so it is a corrupt value there rather than a meaningful
 * one. `string[] | null` columns (`humanQuestionOptions`) are not text and are
 * excluded by construction.
 */
type NullableTextColumn = {
  [K in keyof IssueRow]-?: null extends IssueRow[K]
    ? NonNullable<IssueRow[K]> extends string
      ? K
      : never
    : never
}[keyof IssueRow]

/** The class above, enumerated for the runtime pass. */
export const BLANK_TO_NULL_COLUMNS = [
  'createdByOnBehalfOf',
  'repoId',
  'brief',
  'worktreePath',
  'branch',
  'machineId',
  'linearId',
  'linearIdentifier',
  'linearUrl',
  'activityNotes',
  'notesUpdatedAt',
  'suggestedStage',
  'suggestedReason',
  'dependencyNote',
  'prUrl',
  'deletedAt',
  'assignee',
  'parentId',
  'design',
  'acceptance',
  'notes',
  'dueAt',
  'deferUntil',
  'closedReason',
  'closedAt',
  'landedAt',
  'landedSha',
  'supersededBy',
  'duplicateOf',
  'sortKey',
  'color',
  'humanQuestion',
  'humanQuestionAskedBy',
  'humanQuestionAskedAt',
  'panel',
  'coordinatorSessionId',
  'startedBySession',
] as const satisfies readonly NullableTextColumn[]

/**
 * Fails to compile when `IssueRow` gains a nullable text column the list above
 * does not carry. The error names the missing key, because the unresolved
 * `Exclude<…>` is what refuses to be assignable to `true`.
 */
type MissingColumns = Exclude<NullableTextColumn, (typeof BLANK_TO_NULL_COLUMNS)[number]>
const _everyNullableTextColumnIsListed: [MissingColumns] extends [never] ? true : MissingColumns =
  true
void _everyNullableTextColumnIsListed

/**
 * Collapse `''` to `null` on every nullable text column, in place.
 *
 * Mutates rather than copies: `persistWith` is handed the MAP-OWNED row object
 * on an update, and every holder of that reference must see the same value the
 * store just committed.
 */
export function normalizeBlankIssueText(row: IssueRow): IssueRow {
  for (const column of BLANK_TO_NULL_COLUMNS) {
    // The view is narrowed to the columns being written rather than to a bare
    // index signature: every listed key really does accept `null` by definition
    // of {@link NullableTextColumn}, so this is a widening of the brands, not an
    // escape from the row's type.
    if (row[column] === '') (row as { [K in NullableTextColumn]?: string | null })[column] = null
  }
  return row
}
