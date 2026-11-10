/**
 * AN ISSUE'S BODIES, FETCHED BY ID (POD-6767, design POD-6253 §2).
 *
 * The synced issue record carries only the headers of `brief` and `description` (the `issueBodies` row); a screen that shows
 * one asks for it here. Each body is answered with the digest its header names,
 * so the client caches it by content and asks again only when the header moves.
 *
 */

import {
  ISSUE_BODY_FIELDS,
  type IssueBodyField,
  type IssueBodyWire,
  type UserId,
} from '@podium/model'
import type { IssueRow } from '../../store/types'
import type { ExecutionFactsStore } from './execution-visibility'
import { issueBodyHeaderOf, issueBodyValuesOfRow } from './projection'

export interface IssueBodiesRead {
  /** The issues by id; a missing id is absent. */
  rows(ids: readonly string[]): Promise<ReadonlyMap<string, IssueRow>>
  readonly store: ExecutionFactsStore
}

/**
 * The bodies of `ids` that `viewer` may read, for the fields asked (every field
 * when `fields` is absent). A field with no content has no body and is not in
 * the answer, exactly as it has no header. Missing issues are left out.
 */
export async function readIssueBodies(
  read: IssueBodiesRead,
  viewer: UserId | null,
  ids: readonly string[],
  fields: readonly IssueBodyField[] = ISSUE_BODY_FIELDS,
): Promise<IssueBodyWire[]> {
  const rows = await read.rows([...new Set(ids)])
  if (rows.size === 0) return []
  const out: IssueBodyWire[] = []
  for (const row of rows.values()) {
    // A deleted issue has left the feed, record and headers both.
    if (row.deletedAt) continue
    let values: Partial<Record<IssueBodyField, unknown>>
    try {
      values = issueBodyValuesOfRow(row)
    } catch {
      // A row the feed cannot project has no record and no headers either.
      continue
    }
    for (const field of fields) {
      const value: unknown = values[field]
      const header = issueBodyHeaderOf(field, value)
      if (!header) continue
      out.push({ issueId: row.id, field, digest: header.digest, value })
    }
  }
  return out
}
