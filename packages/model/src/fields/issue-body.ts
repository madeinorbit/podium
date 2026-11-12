import { z } from 'zod'
import { IssueIdField } from '../ids'

/**
 * AN ISSUE'S FAT FIELDS AS THEIR OWN SYNCED RECORDS (POD-6921, design POD-6253 §2).
 *
 * `brief` and `description` were 28 of 37 MB of issue data, and every small
 * change to an issue resent them. They are not on the synced issue record.
 * Each is a synced kind of its own, keyed by the issue id and holding the whole
 * text: `issueBrief` and `issueDescription`. They are built from the issue row,
 * logged and loaded at start like every other kind. A field with no text has
 * no record: emptying it removes the record, filling it adds one.
 *
 * The panel and the activity notes are records of their own too
 * (`issuePanelTodo`, `issuePanelArtifact`, `issuePanelDeferred`,
 * `issuePanelState`: see `entities/issue-panel-records.ts`).
 *
 * Command results and the CLI still carry the whole issue projection.
 */

/** The synced `issueBrief` record: the issue's agent brief. */
export const IssueBriefWire = z.object({
  id: IssueIdField,
  text: z.string().min(1),
})
export type IssueBriefWire = z.infer<typeof IssueBriefWire>

/** The synced `issueDescription` record: the text of the issue's description
 *  document (its `value`). */
export const IssueDescriptionWire = z.object({
  id: IssueIdField,
  text: z.string().min(1),
})
export type IssueDescriptionWire = z.infer<typeof IssueDescriptionWire>

/** The body kinds, one per field, each keyed by the issue id. */
export const ISSUE_BODY_KINDS = ['issueBrief', 'issueDescription'] as const
export type IssueBodyKind = (typeof ISSUE_BODY_KINDS)[number]
export const isIssueBodyKind = (kind: string): kind is IssueBodyKind =>
  (ISSUE_BODY_KINDS as readonly string[]).includes(kind)

/** The fields the synced issue record leaves out: the two bodies above, and
 *  the panel and notes that live in the panel records. */
const ISSUE_RECORD_OMITTED = ['brief', 'description', 'panel', 'activityNotes', 'notesUpdatedAt']

/** The issue record without its body fields. Returns the same object when it
 *  has none, so an unchanged row keeps its identity. */
export function withoutIssueBodies<T extends object>(issue: T): T {
  const record = issue as Record<string, unknown>
  if (!ISSUE_RECORD_OMITTED.some((field) => field in record)) return issue
  const out = { ...record }
  for (const field of ISSUE_RECORD_OMITTED) delete out[field]
  return out as T
}

/** The `issueBrief` text of a brief value, or `undefined` when it has none. */
export function issueBriefText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The `issueDescription` text of a description document (or a plain
 *  string), or `undefined` when it has none. */
export function issueDescriptionText(value: unknown): string | undefined {
  const text =
    value !== null && typeof value === 'object' ? (value as { value?: unknown }).value : value
  return typeof text === 'string' && text.length > 0 ? text : undefined
}
