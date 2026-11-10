import { z } from 'zod'
import { IssueIdField } from '../ids'

/**
 * AN ISSUE'S FAT FIELDS, SPLIT INTO HEADER AND BODY (POD-6767, design POD-6253 §2).
 *
 * `brief`, `panel`, `description` and `activityNotes` were 28 of 37 MB of issue
 * data, and every small change to an issue resent them (up to 140 KB). They now
 * leave the synced issue record. In their place each issue has ONE small synced
 * row, `issueBodies`, keyed by the issue id, with a header per field that has
 * content: a digest of the stored value and its size. The body itself is
 * fetched by id when a screen needs it (`issues.bodies`) and cached by digest.
 *
 * - A field with no content has no header, so "nothing here" needs no fetch.
 * - The digest is content-addressed: any process builds the same header from
 *   the issue row alone, and an unchanged body keeps its cached copy across
 *   unrelated writes to the issue.
 * - A body edit still bumps the issue's revision, so the slim issue record
 *   changes on the same write: the change is about 1 KB, never the whole body.
 */
export const ISSUE_BODY_FIELDS = ['brief', 'panel', 'description', 'activityNotes'] as const
export type IssueBodyField = (typeof ISSUE_BODY_FIELDS)[number]
export const IssueBodyFieldName = z.enum(ISSUE_BODY_FIELDS)

/** One field's header: which content it holds (digest) and how big it is. */
export const IssueBodyHeader = z.object({
  /** Digest of the stored value's text ({@link issueBodyText}); the cache key. */
  digest: z.string().min(1),
  /** UTF-8 bytes of that text. */
  size: z.number().int().nonnegative(),
})
export type IssueBodyHeader = z.infer<typeof IssueBodyHeader>

/** The headers of one issue's bodies, one per field with content. */
export const IssueBodyHeaders = z.object({
  brief: IssueBodyHeader.optional(),
  panel: IssueBodyHeader.optional(),
  description: IssueBodyHeader.optional(),
  activityNotes: IssueBodyHeader.optional(),
})
export type IssueBodyHeaders = z.infer<typeof IssueBodyHeaders>

/** The synced `issueBodies` row: the headers of one issue's bodies. */
export const IssueBodiesWire = z.object({
  id: IssueIdField,
  ...IssueBodyHeaders.shape,
})
export type IssueBodiesWire = z.infer<typeof IssueBodiesWire>

/** One fetched body, as `issues.bodies` answers. `value` has the field's wire
 *  shape: a string, the `{ value }` document for `description`, the panel
 *  object (shaped for the reader) for `panel`. */
export const IssueBodyWire = z.object({
  issueId: IssueIdField,
  field: IssueBodyFieldName,
  digest: z.string().min(1),
  value: z.unknown(),
})
export type IssueBodyWire = z.infer<typeof IssueBodyWire>

/** The issue record without its body fields. Returns the same object when it
 *  has none, so an unchanged row keeps its identity. */
export function withoutIssueBodies<T extends object>(issue: T): T {
  const record = issue as Record<string, unknown>
  if (!ISSUE_BODY_FIELDS.some((field) => field in record)) return issue
  const out = { ...record }
  for (const field of ISSUE_BODY_FIELDS) delete out[field]
  return out as T
}

/**
 * The text a body's header describes, or `undefined` when the field holds
 * nothing worth fetching (absent, empty text, an empty document, a panel with
 * no entries). Strings are themselves; the description is its document's
 * value; the panel is its JSON.
 */
export function issueBodyText(field: IssueBodyField, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (field === 'description') {
    const text = (value as { value?: unknown }).value
    return typeof text === 'string' && text.length > 0 ? text : undefined
  }
  if (field === 'panel') {
    const panel = value as { todos?: unknown[]; artifacts?: unknown[]; deferred?: unknown[] }
    const entries =
      (panel.todos?.length ?? 0) + (panel.artifacts?.length ?? 0) + (panel.deferred?.length ?? 0)
    return entries > 0 ? JSON.stringify(value) : undefined
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** UTF-8 bytes of a body's text, counted without an encoder (the model runs
 *  where no `TextEncoder` is declared). A lone surrogate counts as the three
 *  bytes of its replacement character, as an encoder would write it. */
export function issueBodySize(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}
